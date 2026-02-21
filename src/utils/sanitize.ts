/**
 * Utilitários para sanitização e normalização de dados extraídos via scraping.
 */

/** Remove espaços extras e normaliza quebras de linha. */
export function cleanText(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

/** Extrai apenas números de uma string (útil para CPF, CNPJ, número de processo). */
export function onlyNumbers(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\D/g, '');
}

/** Normaliza formato de data para ISO 8601 (YYYY-MM-DD). */
export function normalizeDate(text: string | null | undefined): string | undefined {
  if (!text) return undefined;

  const cleaned = cleanText(text);

  // Formato dd/mm/yyyy
  const ptBrMatch = cleaned.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (ptBrMatch) {
    const [, day, month, year] = ptBrMatch;
    return `${year}-${month}-${day}`;
  }

  // Formato yyyy-mm-dd (já em ISO)
  if (/^\d{4}-\d{2}-\d{2}/.test(cleaned)) {
    return cleaned.slice(0, 10);
  }

  return cleaned;
}

/** Sanitiza string de ID removendo caracteres inválidos. */
export function sanitizeId(id: string | null | undefined): string {
  if (!id) return '';
  return id.replace(/[^\w\-]/g, '').trim();
}

/** Extrai dados de uma tabela HTML em formato de array de objetos. */
export function tableToObjects(
  rows: Array<{ cells: Array<string | null> }>,
  headers: string[],
): Record<string, string>[] {
  return rows.map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((header, i) => {
      obj[header] = cleanText(row.cells[i]) ?? '';
    });
    return obj;
  });
}

/** Remove dados sensíveis de um objeto antes de logar. */
export function redactSensitive<T extends Record<string, unknown>>(
  obj: T,
  fields: string[] = ['password', 'senha', 'token', 'apiKey', 'api_key'],
): Partial<T> {
  const result = { ...obj };
  for (const field of fields) {
    if (field in result) {
      (result as Record<string, unknown>)[field] = '[REDACTED]';
    }
  }
  return result;
}
