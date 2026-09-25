# Agenda — eventos (compromissos) do Astrea: discovery e confirmação em runtime

**Data**: 25/09/2026 · **Conta**: usuário de automação (`admin@alvesbernabe.com`, id `6528036269752320`) · **Consumidor**: agenda da atendente virtual Léia (n8n) — plano em `assistente-marketing-escritorio/docs/plano-agenda-astrea-2026-09-25.md`.

## 1. Como foi descoberto

1. **Leitura estática** do bundle público do frontend (`https://astrea.net.br/js/all.min.js`, módulos `appointmentService` e `AppointmentForm.buildJson`) e dos discovery docs públicos dos GCP Endpoints — sem nenhuma chamada autenticada.
2. **Confirmação em runtime**: a própria api-astrea (branch `feat/agenda-disponibilidade-eventos`) rodando local contra o Astrea real, criando, lendo, remarcando, cancelando e excluindo eventos de teste na agenda do usuário de automação (26–27/10/2026), e um contato + atendimento de teste. Tudo foi apagado ao final (tabela no §6).

## 2. Endpoints confirmados (`https://app.astrea.net.br/api/v2`, Bearer da sessão via `$http`)

| Operação | Método / caminho | Corpo | Resposta observada |
|---|---|---|---|
| Criar evento | `POST /appointments` | AppointmentDTO (§3) | objeto com `id` (Long) — aceito de primeira com o payload do formulário |
| Carregar | `GET /appointments/{id}` | — | DTO (§4). Evento excluído → **410** "Este evento já foi excluído." |
| Remarcar | `PUT /appointments/reschedule` | `{id, userId, whenDate, toDate, allDay, timeFromTo:"HH:mm - HH:mm", shouldNotify:false}` | ok |
| Mudar status | `PUT /appointments/status` | `{appointmentId, userId, status:"CANCELED"\|"DONE"\|"IN_PROGRESS", reason?}` | ok; o evento continua existindo com `status: CANCELED` |
| Excluir | `DELETE /appointments/{id}` | — | ok |
| Excluir atendimento | `DELETE /consulting/{id}/user/{userId}` | — | ok (resposta vazia) |
| Pode excluir contato? | `GET /contact/can-delete/{id}` | — | `{response: true}` |
| Excluir contato | `DELETE /contact/{id}` | — | `{response: true}` |

## 3. Corpo do `POST /appointments` (o que a api-astrea envia — `agenda-appointment-payload.ts`)

`description` (título), `descriptionDetails` (observações; a api acrescenta `[ref:<chaveExterna>]`), `responsibleId`, `owner`/`userId` (usuário da sessão), `allDay`, `fromDate`/`toDate` (dia às 12:00 BRT em ISO UTC), `beginDate`/`endDate` (`"YYYYMMDD"`), `timeStart`/`timeEnd`, `hourStart`/`minStart`/`hourEnd`/`minEnd`, `timeFromTo`, `intDate`, `intTime`, `address`, `addressType` (`ONLINE_MEETING` \| `PHYSICAL_ADDRESS`), alertas/lembretes vazios, `notifyCustomers:false`, `caseId` (id de caso **ou de atendimento/consulting** — aceito), `involvedWithNames` (id → nome), campos de kanban vazios.

## 4. O que volta na leitura (atenção às diferenças)

- **`GET /appointments/{id}`**: data em `whenDate` / `toDateInt` (**número** `YYYYMMDD`); `fromDate`/`toDate`/`startAt`/`endAt` são **epoch ms do horário real**; `timeStart`/`timeEnd`/`timeFromTo`; observações em **`descriptionDetails`**. O campo `comments` deste DTO é **o log do Astrea** ("Evento criado em … por …"), não as observações.
- **`POST /calendar-pro/complete`** (listagem): as observações vêm em **`comments`** (string) — é o que permite a idempotência por `[ref:]`. Traz `version`, `involvedIds`, `status` (`IN_PROGRESS`/`DONE`/`CANCELED`). **Eventos cancelados continuam aparecendo** com `status: CANCELED` (a api mapeia para `cancelado` e não os conta como ocupados).

## 5. Pegadinhas confirmadas

- **A busca de contatos (`POST /contact/all`, `queryDTO.text`) NÃO indexa telefone** — testado com `+55 27 90000-0001`, `27900000001`, `(27) 90000-0001`, `90000-0001`, `900000001`: nada. Só o **nome** encontra. O telefone fica gravado como digitado. Por isso a agenda acha o contato pelo nome e confirma pelo telefone (`telefonesIguais`: 8 últimos dígitos + DDD quando os dois têm).
- Criar contato navega a aba para o formulário (`loadDefaultContactDraft`); a aba quente não é estacionada fora da rota padrão, então a chamada seguinte paga o boot da SPA (~15 s).
- IDs Long do Astrea ficam abaixo de 2^53 hoje (~4,6–6,7 × 10^15), mas são tratados como **string** em toda a api.
- Latências medidas (local, 25/09): cold start (browser + login + SPA) 34 s; disponibilidade do cache 0,02 s; disponibilidade `fresh=1` com aba quente 0,48 s; criar evento sem contato 1,4 s; com contato novo + atendimento 25 s; remarcar 1,3 s; cancelar 0,85 s; excluir 0,76 s.

## 6. Registros de teste criados e apagados

| Tipo | Id | Situação |
|---|---|---|
| Evento "TESTE API - PODE EXCLUIR" (26/10 10:00, depois 11:00) | `4677806899625984` | remarcado, cancelado e **excluído** |
| Evento "TESTE API LEIA - PODE EXCLUIR - ONLINE" (27/10 10:00) | `4685753562202112` | **excluído** |
| Atendimento (consulting) do teste | `6328179028688896` | **excluído** |
| Contato "TESTE API LEIA PODE EXCLUIR" (+55 27 90000-0001, fictício) | `5765229075267584` | **excluído** (conferido: busca pelo nome volta vazia) |
