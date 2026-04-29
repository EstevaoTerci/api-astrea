# CLAUDE.md

## Consumidor principal

Esta API é consumida quase que exclusivamente pelo projeto [`assistente-claude-escritorio`](C:\Users\evert\Desktop\Projetos\assistente-claude-escritorio) (repositório <https://github.com/EstevaoTerci/assistente-claude-escritorio>).

Mudanças de contrato (rotas, payloads, headers, códigos de erro) devem considerar o impacto nesse consumidor antes de serem aplicadas. Quando houver dúvida sobre um endpoint estar em uso, verifique o código do `assistente-claude-escritorio` antes de remover ou alterar comportamento.
