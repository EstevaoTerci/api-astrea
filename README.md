# API Astrea

API REST que expõe dados do sistema jurídico [Astrea](https://astrea.net.br) via HTTP requests autenticadas e scraping controlado com Playwright. Também expõe um endpoint MCP remoto para clientes compatíveis com o protocolo.

## Endpoints

| Método  | Rota                                            | Descrição                                              |
| ------- | ----------------------------------------------- | ------------------------------------------------------ |
| `GET`   | `/health`                                       | Health check                                           |
| `POST`  | `/api/clientes`                                 | Cria cliente/contato                                   |
| `GET`   | `/api/clientes`                                 | Buscar clientes (ver filtros abaixo)                   |
| `GET`   | `/api/clientes/todos`                           | Lista completa de todos os clientes (ver filtros)      |
| `GET`   | `/api/clientes/aniversariantes`                 | Aniversariantes do mês JÁ enriquecidos (`?mes=N`)      |
| `GET`   | `/api/clientes/:id`                             | Detalhes do cliente (inclui documentos)                |
| `PATCH` | `/api/clientes/:id`                             | Atualiza parcialmente o cadastro (campos não passados ficam intactos) |
| `GET`   | `/api/clientes/:id/casos`                       | Casos/processos do cliente                             |
| `GET`   | `/api/casos/:id`                                | Detalhes completos de um caso/processo                 |
| `GET`   | `/api/casos/:id/andamentos`                     | Andamentos do caso                                     |
| `POST`  | `/api/atendimentos`                             | Agenda um atendimento                                  |
| `POST`  | `/api/atendimentos/:id/transformar-em-caso`     | Converte atendimento em caso                           |
| `POST`  | `/api/atendimentos/:id/transformar-em-processo` | Converte atendimento em processo                       |
| `POST`  | `/api/tarefas/:id/comentarios`                  | Adiciona comentário (texto puro) em tarefa             |
| `GET`   | `/api/agenda`                                   | Agenda unificada (prazos+tarefas+atendimentos+audiências) por advogado/janela |
| `GET`   | `/api/agenda/disponibilidade`                   | Intervalos OCUPADOS por usuário (regras de bloqueio aplicadas; cache 60 s) |
| `POST`  | `/api/agenda/eventos`                           | Cria compromisso (idempotente por `chaveExterna`; 409 em conflito; contato + atendimento opcionais) |
| `GET`   | `/api/agenda/eventos`                           | Compromissos de um contato (telefone + nome, ou `chaveExterna`) |
| `GET`   | `/api/agenda/eventos/:id`                       | Carrega um compromisso |
| `PATCH` | `/api/agenda/eventos/:id`                       | Remarca (checa conflito) — só eventos da automação, salvo `?forcar=1` |
| `POST`  | `/api/agenda/eventos/:id/cancelar`              | Cancela (status CANCELED, mantém histórico) — idem |
| `DELETE`| `/api/agenda/eventos/:id`                       | Exclui — idem |

### Filtros nativos do Astrea (queryDTO) em `GET /api/clientes` e `GET /api/clientes/todos`

Mapeiam direto para o `queryDTO` do `POST /contact/all` interno do Astrea — aplicados server-side, **sem chamadas extras**. Cada filtro reduz a quantidade de dados trafegados e elimina a necessidade de buscar o detalhe individual de cada contato.

| Param           | Tipo            | Mapeia para                                | Disponível em                |
| --------------- | --------------- | ------------------------------------------ | ---------------------------- |
| `nome`          | `string`        | `queryDTO.text` (busca textual)            | `GET /api/clientes`          |
| `cpfCnpj`       | `string`        | `queryDTO.text` (com/sem máscara)          | `GET /api/clientes`          |
| `email`         | `string`        | filtro local pós-resposta                  | `GET /api/clientes`          |
| `mesAniversario`| `1..12`         | `queryDTO.birthMonth`                      | ambos                        |
| `estado`        | `string` (UF)   | `queryDTO.state`                           | ambos                        |
| `etiquetasIds`  | `number[]` (CSV ou repetido) | `queryDTO.selectedTagsIds`    | ambos                        |
| `apenasComEmail`| `boolean`       | `queryDTO.onlyWithEmail`                   | ambos                        |
| `buscarEmEmpresa`| `boolean`      | `queryDTO.searchInCompany`                 | apenas `GET /api/clientes`   |

**Caso de uso típico:** "aniversariantes do mês" passa de `1 + N` chamadas (1 para listar IDs + N para buscar detalhe de cada) para `1 + ~N/12` (a chamada inicial já filtra por mês — só os ~190 do mês precisam de detalhe, em vez de 2.300+ do total).

### `GET /api/clientes/aniversariantes?mes=N` (tool MCP `listar_aniversariantes`)

Devolve os aniversariantes do mês **já enriquecidos** (`dataNascimento` em ISO, `cpfCnpj`, telefone, email, endereço, `tipo`) numa única chamada de API. Internamente combina `POST /contact/all` (filtro `birthMonth`) + `GET /contact/{id}/details` por contato, com concorrência limitada numa só aba e cache de 60s. Aceita também `estado` (UF) e `etiquetasIds`.

> Migrado em 2026-06-22 do endpoint interno `/report/contactdetail`, que quebrou em produção (`API_ERROR_-1`). Ver [docs/2026-06-22-fix-aniversariantes-e-login-resiliente.md](docs/2026-06-22-fix-aniversariantes-e-login-resiliente.md).

### `GET /api/agenda` — agenda unificada por advogado

Wrapper fino sobre o endpoint interno `/calendar-pro/complete` do Astrea, o mesmo que monta a tela "Agenda" do app. Retorna prazos, tarefas, atendimentos e audiências numa única resposta — útil pra perguntas tipo "o que o LB tem essa semana?" sem orquestrar 3-4 chamadas no cliente.

| Param            | Tipo                                                | Default                          | Notas |
| ---------------- | --------------------------------------------------- | -------------------------------- | ----- |
| `responsavelId`  | `string`                                            | todos os usuários ativos         | ID numérico do Astrea (use `GET /api/usuarios` para descobrir) |
| `inicio`         | `YYYY-MM-DD`                                        | domingo da semana corrente       | |
| `fim`            | `YYYY-MM-DD`                                        | 6 dias após `inicio`             | inclusivo |
| `tipos`          | CSV ou repetido: `prazo,tarefa,atendimento,audiencia` | todos                          | ex.: `tipos=audiencia,atendimento` |
| `status`         | `todos` \| `pendentes` \| `concluidos`              | `todos`                          | mapeia para `IN_PROGRESS`/`DONE` no Astrea |
| `incluirSemPrazo`| `boolean`                                           | `false`                          | quando true, anexa tarefas sem deadline; só tem efeito se `tipos` incluir `tarefa` |

Cada item retornado tem `tipo`, `tituloComResponsavel` (formato `"LB - Verificar processo"` igual ao app), `responsavelNome`, `urlCaso`, `numeroProcesso`, e campos específicos por tipo (`horaInicio`/`horaFim` para atendimentos/audiências; `forum`/`endereco`/`sala` para audiências).

### Agenda — disponibilidade e eventos (agenda da atendente virtual)

Contrato confirmado contra o Astrea real em 25/09/2026 — ver [docs/agenda-eventos-discovery.md](docs/agenda-eventos-discovery.md).

**`GET /api/agenda/disponibilidade?responsavelIds=<id,id>&inicio=YYYY-MM-DD&fim=YYYY-MM-DD[&fresh=1][&incluirTitulos=1][&tipos=][&duracaoPadraoMin=30]`**
Devolve `busy` e `porResponsavel` com intervalos semiabertos `[inicio, fim)` em ISO `-03:00`. Regras: evento de dia inteiro bloqueia o dia; evento em que a pessoa é só **envolvida** também ocupa; sem hora de fim → +`duracaoPadraoMin`; **cancelados não ocupam**; sobrepostos são fundidos e `origens` explica cada bloco. Títulos (podem ter nome de cliente) só com `incluirTitulos=1`. Janela máx. 31 dias. Cache 60 s; `fresh=1` fura (use antes de agendar). Qualquer não-200 = não ofereça horários.

**`POST /api/agenda/eventos`** (corpo `.strict()`):
```json
{ "titulo": "ATENDIMENTO INICIAL - NOME - ONLINE", "data": "2026-09-30", "horaInicio": "14:00", "horaFim": "14:30",
  "responsavelId": "<advogado>", "envolvidosIds": ["<secretária>"], "comentarios": "link da conversa…",
  "chaveExterna": "n8n-ag#123", "modalidade": "remoto", "endereco": "…",
  "contato": { "nome": "Nome Completo", "telefone": "+5527…" }, "criarAtendimento": true, "verificarConflito": true }
```
- **201** criado · **200** `reaproveitado: true` (já existia evento ativo com a mesma `[ref:chaveExterna]`) · **409** `CONFLICT` com `details.conflitos` (sem títulos) · **503** com `Retry-After` · **504** timeout (pode ter criado: repita com a mesma chave).
- Idempotência: a `chaveExterna` é gravada nas observações como `[ref:…]`; repetir a chamada (retry, timeout) não duplica evento nem atendimento; chamadas simultâneas com a mesma chave compartilham o resultado.
- `contato`: acha pelo **nome** e confirma pelo telefone (a busca do Astrea não indexa telefone); senão cria (sem CPF). Com `criarAtendimento`, abre um Atendimento de CRM e o usa como `caseId` do evento. Tudo em melhor esforço: `parcial: true` + `erros` se contato/atendimento/vínculo falhar — o evento é criado mesmo assim.

**`GET /api/agenda/eventos?telefone=&nome=&chaveExterna=&inicio=&fim=&responsavelIds=[&incluirCancelados=1]`** — compromissos de um contato: `motivo` `ref` (observações com a `[ref:]`), `caso` (caseId é atendimento/caso do contato achado por **nome + telefone**) ou `observacoes` (telefone escrito nas observações). Exige telefone ou chaveExterna.

**Mutações por id** (`PATCH`, `/cancelar`, `DELETE`): por segurança só valem para eventos criados pela automação (com `[ref:]`); para os demais, `?forcar=1` (403 `FORBIDDEN` sem ele). As tools MCP (uso humano) forçam.

**Aba quente**: estas rotas reutilizam uma aba estacionada do pool (`/health` → `pool.warm`), o que derruba a latência de 15–40 s para ~0,5–1,5 s. Recomenda-se um keep-alive (uma disponibilidade a cada 10 min no expediente) para não cair no cold start após 15 min ocioso.

## Autenticação

Todas as rotas `/api/*` e `/mcp` requerem header `x-api-key` com o valor definido em `API_KEY`.

## MCP remoto

O projeto mantém o servidor MCP em `stdio` para integrações locais e também expõe um endpoint HTTP remoto em `/mcp`.

- URL: `POST/GET/DELETE /mcp`
- Transporte: `Streamable HTTP`
- Header obrigatório: `x-api-key: <API_KEY>`
- Sessão: o cliente inicializa a sessão com `POST /mcp`; o servidor devolve `Mcp-Session-Id` e o cliente reutiliza esse header nas chamadas seguintes

Para clientes remotos, prefira apontar para a URL interna do serviço no Coolify, por exemplo `http://api-astrea:3000/mcp`, ou para um domínio publicado se você decidir expor esse endpoint externamente.

As operações de mutação novas também ficam disponíveis no MCP remoto/stdio:

- `criar_cliente`
- `atualizar_cliente` — PATCH parcial no cadastro do contato (corrigir typo no nome, atualizar telefone/email/endereço/etc.). Campos não informados ficam intactos. Não permite alterar perfil/tipo (cliente↔contato, PF↔PJ) — para isso, use a UI do Astrea.
- `transformar_atendimento_em_caso`
- `transformar_atendimento_em_processo`
- `comentar_tarefa` — adiciona comentário em tarefa (texto puro; não aceita menção `@usuário` nem anexos nesta versão)

As tools de listagem `listar_clientes` e `listar_todos_clientes` também aceitam os filtros nativos do `queryDTO` documentados acima (`mesAniversario`, `estado`, `etiquetasIds`, `apenasComEmail`, `buscarEmEmpresa`).

## Deploy com Docker

```bash
# 1. Copiar e preencher variáveis de ambiente
cp .env.example .env

# 2. Subir com Docker Compose local
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

## Coolify

Use o `docker-compose.yml` do repositório como arquivo principal da resource `Docker Compose`.

1. Crie uma nova resource do tipo `Docker Compose` no Coolify apontando para este repositório.
2. Use apenas o arquivo `docker-compose.yml` no deploy da VPS.
3. Configure as variáveis de ambiente no painel do Coolify. O compose já declara todas explicitamente para o UI detectá-las.
4. Mantenha `TRUST_PROXY=1` quando a API ficar atrás do proxy do Coolify.
5. Se a API for usada apenas por `n8n` e outros serviços internos, prefira acesso interno em rede e não publique porta/URL desnecessariamente.

### Variáveis mínimas de produção

- `ASTREA_EMAIL`
- `ASTREA_PASSWORD`
- `API_KEY`

### Recomendação inicial para VPS pequena

- `NODE_ENV=production`
- `TRUST_PROXY=1`
- `BROWSER_HEADLESS=true`
- `BROWSER_POOL_SIZE=3`
- `BROWSER_IDLE_TTL_MS=900000`
- `RATE_LIMIT_MAX_REQUESTS=60`
- `SESSION_REUSE=true` (restaura a sessão no cold-start em vez de re-logar)
- `BROWSER_LOGIN_TIMEOUT_MS=45000`, `LOGIN_BREAKER_THRESHOLD=3`, `LOGIN_BREAKER_COOLDOWN_MS=60000` (resiliência de login — ver abaixo)

### Rede com n8n

Se o `n8n` estiver na mesma stack/rede do Coolify, prefira chamadas internas na porta `3000`.

Se o `n8n` estiver em outra stack, as opções práticas são:

- expor um domínio protegido por `x-api-key`
- ligar ambas as stacks a uma rede compartilhada no Docker/Coolify

## Observações de produção

- O compose principal não fixa `container_name`, o que evita conflito em re-deploys do Coolify.
- O compose principal não publica porta no host. Para rodar localmente, use o override `docker-compose.local.yml`.
- O projeto usa um único browser/contexto com sessão compartilhada e fecha cada aba ao final da requisição.
- O browser usa lazy init e é encerrado automaticamente após o TTL de ociosidade configurado.
- O runtime de produção usa a imagem oficial do Playwright para manter o browser alinhado com a versão instalada no projeto.
- **Login resiliente**: a sessão é persistida em `storageState` (`SESSION_REUSE`), então o cold-start após o idle-shutdown restaura a sessão em vez de re-logar. Um circuit breaker segura novos logins após falhas consecutivas (evita tempestade de logins / detecção de uso indevido na Astrea), e falhas de login chegam como `LOGIN_FAILED_<STATE>` / `LOGIN_CIRCUIT_OPEN` (503 + `Retry-After`). O `GET /health` expõe o bloco `login` (estado do breaker, sessão e contadores) para monitorar. Detalhes em [docs/2026-06-22-fix-aniversariantes-e-login-resiliente.md](docs/2026-06-22-fix-aniversariantes-e-login-resiliente.md).

## Desenvolvimento local

```bash
npm install
cp .env.example .env
npm run dev
```

## Stack

- Runtime: Node.js 22 + TypeScript
- Framework: Express.js
- Browser: Playwright
- Deploy: Docker multi-stage build
