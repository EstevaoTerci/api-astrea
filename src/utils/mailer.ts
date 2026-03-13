import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from './logger.js';

interface ScrapingIncident {
  operation: string;
  error: Error;
  url: string;
  llmFix: string;
  llmCodeSuggestion: string;
}

/**
 * Envia notificação de incidente de scraping ao desenvolvedor via SMTP.
 * Silencia se SMTP_HOST não estiver configurado.
 */
export async function notifyScrapingIncident(incident: ScrapingIncident): Promise<void> {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    logger.debug({ incident: incident.operation }, 'SMTP não configurado — notificação de incidente ignorada');
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });

    const subject = `[api-astrea] Falha de scraping auto-corrigida: ${incident.operation}`;
    const html = `
      <h2>Falha de scraping auto-corrigida</h2>
      <p><strong>Operação:</strong> ${incident.operation}</p>
      <p><strong>URL:</strong> ${incident.url}</p>
      <p><strong>Erro original:</strong></p>
      <pre>${incident.error.message}\n\n${incident.error.stack ?? ''}</pre>
      <p><strong>O que o LLM fez para resolver:</strong></p>
      <pre>${incident.llmFix}</pre>
      <p><strong>Sugestão de correção de código:</strong></p>
      <pre>${incident.llmCodeSuggestion}</pre>
      <hr>
      <p><small>Enviado automaticamente por api-astrea</small></p>
    `;

    await transporter.sendMail({
      from: env.SMTP_USER,
      to: env.DEVELOPER_EMAIL,
      subject,
      html,
    });

    logger.info({ operation: incident.operation }, 'Email de incidente enviado');
  } catch (err) {
    logger.warn({ err }, 'Erro ao enviar email de incidente');
  }
}
