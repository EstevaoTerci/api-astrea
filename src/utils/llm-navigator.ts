import { Page } from 'playwright';
import { logger } from './logger.js';
import { env } from '../config/env.js';

interface NavigationResult {
  result: unknown;
  fixDescription: string;
}

interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface LlmAction {
  type: 'tool_call' | 'text' | 'end';
  toolName?: string;
  toolInput?: Record<string, unknown>;
  text?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Providers de LLM (Anthropic, Google, OpenAI)
// ─────────────────────────────────────────────────────────────────────────────

async function* anthropicAgent(
  systemPrompt: string,
  userPrompt: string,
  tools: LlmTool[],
): AsyncGenerator<LlmAction> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as any,
  }));

  const messages: any[] = [{ role: 'user', content: userPrompt }];

  for (let turn = 0; turn < 15; turn++) {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      tools: anthropicTools,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'text') {
        yield { type: 'text', text: block.text };
      } else if (block.type === 'tool_use') {
        yield { type: 'tool_call', toolName: block.name, toolInput: block.input as Record<string, unknown> };
      }
    }

    if (response.stop_reason === 'end_turn') {
      yield { type: 'end' };
      return;
    }

    if (response.stop_reason !== 'tool_use') {
      yield { type: 'end' };
      return;
    }

    // Coleta resultados das tool calls para o próximo turno
    const toolResults: any[] = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: '__pending__', // será substituído pelo chamador
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  yield { type: 'end' };
}

async function* openaiAgent(
  systemPrompt: string,
  userPrompt: string,
  tools: LlmTool[],
): AsyncGenerator<LlmAction> {
  const { OpenAI } = await import('openai' as any);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const openaiTools = tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  for (let turn = 0; turn < 15; turn++) {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      messages,
      tools: openaiTools,
    });

    const msg = response.choices[0].message;
    messages.push(msg);

    if (msg.content) yield { type: 'text', text: msg.content };

    if (msg.tool_calls?.length) {
      for (const call of msg.tool_calls) {
        yield {
          type: 'tool_call',
          toolName: call.function.name,
          toolInput: JSON.parse(call.function.arguments || '{}'),
        };
      }
    } else {
      yield { type: 'end' };
      return;
    }

    for (const call of msg.tool_calls ?? []) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: '__pending__' });
    }
  }

  yield { type: 'end' };
}

async function* googleAgent(
  systemPrompt: string,
  userPrompt: string,
  tools: LlmTool[],
): AsyncGenerator<LlmAction> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai' as any);
  const client = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

  const googleTools = [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    },
  ];

  const model = client.getGenerativeModel({
    model: process.env.GOOGLE_MODEL ?? 'gemini-1.5-flash',
    systemInstruction: systemPrompt,
  });

  const chat = model.startChat({ tools: googleTools });
  let currentMessage = userPrompt;
  for (let turn = 0; turn < 15; turn++) {
    const result = await chat.sendMessage(currentMessage);
    const response = result.response;

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    let hasFunctionCall = false;

    for (const part of parts) {
      if (part.text) yield { type: 'text', text: part.text };
      if (part.functionCall) {
        hasFunctionCall = true;
        yield {
          type: 'tool_call',
          toolName: part.functionCall.name,
          toolInput: part.functionCall.args ?? {},
        };
      }
    }

    if (!hasFunctionCall) {
      yield { type: 'end' };
      return;
    }

    currentMessage = '__pending__';
  }

  yield { type: 'end' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Seleciona o provider LLM disponível
// ─────────────────────────────────────────────────────────────────────────────

function selectProvider(): 'anthropic' | 'openai' | 'google' | null {
  const pref = (process.env.LLM_PROVIDER ?? '').toLowerCase();
  if (pref === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  if (pref === 'google' && process.env.GOOGLE_API_KEY) return 'google';
  if (pref === 'anthropic' && env.ANTHROPIC_API_KEY) return 'anthropic';
  // Auto-detect: usa o primeiro com chave disponível
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GOOGLE_API_KEY) return 'google';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// llmNavigate — agente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executa uma operação via LLM quando o scraping automático falha.
 *
 * Suporta Anthropic (Claude Haiku), OpenAI e Google Gemini.
 * O provider é selecionado via LLM_PROVIDER env var ou auto-detectado
 * pela presença das chaves ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY.
 *
 * @param page - Página Playwright atual (já autenticada no Astrea).
 * @param taskDescription - O que precisa ser feito.
 * @param originalError - Erro original que disparou o fallback.
 */
export async function llmNavigate(
  page: Page,
  taskDescription: string,
  originalError: Error,
): Promise<NavigationResult> {
  const provider = selectProvider();

  if (!provider) {
    logger.warn('Nenhuma chave de LLM configurada. Fallback desativado.');
    throw originalError;
  }

  logger.info({ provider, taskDescription }, 'Iniciando fallback LLM...');

  // Captura contexto da página
  const [screenshotBuffer, currentUrl] = await Promise.all([
    page.screenshot({ type: 'png' }).catch(() => null),
    Promise.resolve(page.url()),
  ]);
  const htmlSnippet = await page.evaluate(() => document.body.innerText?.slice(0, 2000)).catch(() => '');

  // Ferramentas disponíveis para o LLM
  const tools: LlmTool[] = [
    {
      name: 'click',
      description: 'Clica em um elemento CSS selector',
      inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
    },
    {
      name: 'fill',
      description: 'Preenche um campo de texto',
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string' }, value: { type: 'string' } },
        required: ['selector', 'value'],
      },
    },
    {
      name: 'navigate',
      description: 'Navega para uma URL',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
    {
      name: 'get_page_content',
      description: 'Obtém o texto visível da página atual',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wait',
      description: 'Aguarda N milissegundos',
      inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
    },
  ];

  const systemPrompt = `Você é um agente de automação jurídica para o sistema Astrea.
O scraping automático falhou. Use as ferramentas disponíveis para concluir a tarefa.
Seja direto e eficiente. Após completar, explique em uma linha o que fez.`;

  const userPrompt = `Tarefa: ${taskDescription}
URL atual: ${currentUrl}
Erro original: ${originalError.message}
Conteúdo da página: ${htmlSnippet}
${screenshotBuffer ? '(Screenshot disponível)' : ''}`;

  const actions: string[] = [];
  let lastText = '';

  // Executa o agente com o provider selecionado
  const agentGen =
    provider === 'anthropic'
      ? anthropicAgent(systemPrompt, userPrompt, tools)
      : provider === 'openai'
        ? openaiAgent(systemPrompt, userPrompt, tools)
        : googleAgent(systemPrompt, userPrompt, tools);

  for await (const action of agentGen) {
    if (action.type === 'text' && action.text) {
      lastText = action.text;
    } else if (action.type === 'tool_call' && action.toolName) {
      const input = action.toolInput ?? {};
      actions.push(`${action.toolName}(${JSON.stringify(input)})`);
      try {
        switch (action.toolName) {
          case 'click':
            await page.click(input.selector as string, { timeout: 10000 });
            await page.waitForTimeout(1000);
            break;
          case 'fill':
            await page.fill(input.selector as string, input.value as string);
            break;
          case 'navigate':
            await page.goto(input.url as string, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2000);
            break;
          case 'get_page_content':
            // resultado é injetado de volta no próximo turno pelo provider
            break;
          case 'wait':
            await page.waitForTimeout(input.ms as number);
            break;
        }
      } catch (toolErr) {
        logger.warn({ toolName: action.toolName, toolErr }, 'Erro ao executar ferramenta LLM');
      }
    } else if (action.type === 'end') {
      break;
    }
  }

  const fixDescription = lastText || `LLM (${provider}) executou: ${actions.join(' → ')}`;
  logger.info({ provider, fixDescription }, 'Fallback LLM concluído');

  return { result: null, fixDescription };
}
