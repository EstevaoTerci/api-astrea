# Kanban — Discovery dos endpoints internos do Astrea

Sessão de discovery feita via Chrome DevTools MCP em **30/04/2026** logado como
`admin@alvesbernabe.com` (tenant `rafaelvictoralves28`, id `6692712561442816`).

A nova feature **Gestão Kanban** ("NOVO" no menu lateral) usa três endpoints
REST sob `https://app.astrea.net.br/api/v2/kanbans`. Todos exigem `Authorization:
Bearer <jwt-sessão>`. Na nossa API isso é coberto pelo wrapper `astreaApiGet` /
`astreaApiPost` / `astreaApiPut` (a criar) que delega para o `$http` do Angular
da página autenticada via Playwright.

---

## 1. `GET /api/v2/kanbans` — listar quadros

Retorna todos os quadros (boards) do tenant com suas colunas.

### Response (200)

```json
[
  {
    "id": 5259663363833856,
    "name": "PARECER",
    "default": false,
    "columns": [
      { "id": 5644161049985024, "name": "A Fazer",   "color": "#F1F3F4", "type": "BACKLOG" },
      { "id": 5081211096563712, "name": "Fazendo",   "color": "",        "type": "IN_PROGRESS" },
      { "id": 6207111003406336, "name": "Concluído", "color": "",        "type": "DONE" }
    ]
  },
  {
    "id": 6260824608899072,
    "name": "Kanban Padrão",
    "default": true,
    "columns": [ ... ]
  }
]
```

- `id` é `Long` (sempre numérico grande — manter como string ao serializar pra
  fora pra evitar perda de precisão JS).
- `column.type` ∈ `BACKLOG | IN_PROGRESS | DONE`.
- `default: true` marca o quadro principal do tenant.

---

## 2. `POST /api/v2/kanbans/{kanbanId}/activities/query/by-column` — listar atividades de uma coluna

A UI chama uma vez por coluna do quadro selecionado. **Não existe endpoint
"todas as atividades de um quadro de uma vez"** — para popular o board inteiro
é preciso iterar as colunas.

### Request body

```json
{
  "from": 20260401,
  "to": 20260430,
  "columnId": 5644161049985024,
  "limit": 30
}
```

| Campo           | Tipo          | Obrigatório | Observações |
|-----------------|---------------|-------------|-------------|
| `from`          | int (YYYYMMDD)| sim         | Sem zeros à esquerda — é numérico, não string |
| `to`            | int (YYYYMMDD)| sim         | Janela de `dateStart` da atividade |
| `columnId`      | Long          | sim         | Coluna do quadro |
| `limit`         | int           | sim         | UI usa 30 |
| `cursor`        | string        | não         | Token opaco devolvido em respostas com `hasMore: true` |
| `responsibleId` | Long          | não         | Filtra por responsável |
| `involvedIds`   | Long[]        | não         | Filtra por envolvidos (qualquer da lista) |
| `types`         | string[]      | não         | Ex: `["TASK"]`. Outros tipos não foram observados ainda |

### Response (200)

```json
{
  "activities": [
    {
      "id": 5318416194371584,
      "type": "TASK",
      "allDay": true,
      "title": "Aline, esse caso é antigo...",
      "titleWithName": "AB - Aline, esse caso é antigo...",
      "fullyLoaded": true,
      "ownerId": 5514199865163776,
      "responsibleId": 5774496458801152,
      "involvedIds": [],
      "dateStart": "20260404",
      "version": 8,
      "firstOfDay": true,
      "tagIds": [],
      "caseId": 5115635521060864,
      "caseTitle": "JUCINEIA - CIVEL - RMC",
      "customerCase": 5798427290959872,
      "owner": 5514199865163776,
      "involveds": [],
      "canSee": true,
      "canDelete": true,
      "canEdit": true,
      "canMarkAsDone": true,
      "sharingType": "PUBLIC",
      "caseType": "CTE_CASE",
      "createdDate": 1772636893719,
      "kanbanDetails": { "id": 5259663363833856, "columnId": 5644161049985024 },
      "courtComplete": "",
      "completeLawsuit": "JUCINEIA - CIVEL - RMC",
      "commentCount": 0,
      "done": false,
      "status": "IN_PROGRESS",
      "priority": "MEDIUM"
    }
  ],
  "cursor": "Cq4BChEK...",   // só presente quando hasMore=true
  "hasMore": false
}
```

Pegadinhas:

- `dateStart` é **string** YYYYMMDD (≠ `from`/`to` que são int).
- `createdDate` é epoch em ms (não ISO).
- `priority` ∈ `LOW | MEDIUM | HIGH` (≠ representação numérica usada em `tarefas`).
- `status` ∈ `IN_PROGRESS | DONE | ...` — refere-se ao status da atividade
  (mesmo significado do `done`), não da coluna do kanban.
- A relação **atividade ↔ tarefa**: `activity.id` parece ser o `taskId` quando
  `type === "TASK"` — vai precisar confirmar.
- `version` está presente mas **não é exigido no PUT move**.
- Paginação: passar o `cursor` da response anterior. Não há `offset`.

---

## 3. `PUT /api/v2/kanbans/{kanbanId}/activities/{activityId}/move` — mover atividade

### Request body

```json
{ "targetColumnId": 5081211096563712 }
```

### Response

`204 No Content` — corpo vazio. A UI re-busca via `query/by-column` para
refrescar a coluna de origem e destino.

Confirmado por execução real durante discovery (movido `5323043811917824` da
coluna BACKLOG → IN_PROGRESS → BACKLOG do quadro PARECER).

---

## Endpoints testados e que **não** existem (405/timeout)

- `GET /api/v2/kanbans/{kanbanId}` → 405
- `GET /api/v2/kanbans/{kanbanId}/activities/{activityId}` → -1 (sem rota)
- `GET /api/v2/kanbans/{kanbanId}/columns` → -1

Ou seja: a UI só conhece os 3 endpoints listados acima. Detalhe de atividade
individual presumivelmente vem via `taskListService.getTaskWithComments` quando
`activity.type === "TASK"` (mesmo já usado em `tarefas.service.ts`).

---

## Eventos colaterais ignoráveis

A UI também dispara `POST https://cloud.aurum.com.br/nexus/events` (Mixpanel-
like) com payload tipo `{ event: "KanbanboardStatuschanged", ... }`. Não
afeta o estado do kanban — pode ser ignorado.
