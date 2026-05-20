import { describe, it, expect } from 'vitest';
import {
  cleanText,
  onlyNumbers,
  normalizeDate,
  sanitizeId,
  tableToObjects,
  redactSensitive,
} from './sanitize.js';

describe('cleanText', () => {
  it('retorna string vazia para null/undefined/empty', () => {
    expect(cleanText(null)).toBe('');
    expect(cleanText(undefined)).toBe('');
    expect(cleanText('')).toBe('');
  });

  it('colapsa múltiplos espaços/tabs/newlines em um espaço', () => {
    expect(cleanText('  hello   world  ')).toBe('hello world');
    expect(cleanText('foo\t\tbar')).toBe('foo bar');
    expect(cleanText('linha1\n\nlinha2')).toBe('linha1 linha2');
  });

  it('preserva acentos PT-BR', () => {
    expect(cleanText('  São Paulo  ')).toBe('São Paulo');
    expect(cleanText('café  com   leite')).toBe('café com leite');
  });
});

describe('onlyNumbers', () => {
  it('retorna string vazia para falsy', () => {
    expect(onlyNumbers(null)).toBe('');
    expect(onlyNumbers(undefined)).toBe('');
    expect(onlyNumbers('')).toBe('');
  });

  it('extrai dígitos de CPF formatado', () => {
    expect(onlyNumbers('123.456.789-09')).toBe('12345678909');
  });

  it('extrai dígitos de CNPJ formatado', () => {
    expect(onlyNumbers('12.345.678/0001-99')).toBe('12345678000199');
  });

  it('extrai dígitos de número de processo CNJ', () => {
    expect(onlyNumbers('0001234-56.2024.8.26.0100')).toBe('00012345620248260100');
  });

  it('retorna string vazia quando não há dígitos', () => {
    expect(onlyNumbers('abc-def')).toBe('');
  });
});

describe('normalizeDate', () => {
  it('retorna undefined para falsy', () => {
    expect(normalizeDate(null)).toBeUndefined();
    expect(normalizeDate(undefined)).toBeUndefined();
    expect(normalizeDate('')).toBeUndefined();
  });

  it('converte dd/MM/yyyy para ISO yyyy-MM-dd', () => {
    expect(normalizeDate('19/05/2026')).toBe('2026-05-19');
  });

  it('mantém ISO yyyy-MM-dd', () => {
    expect(normalizeDate('2026-05-19')).toBe('2026-05-19');
  });

  it('trunca yyyy-MM-ddTHH:mm:ss para a parte da data', () => {
    expect(normalizeDate('2026-05-19T14:30:00Z')).toBe('2026-05-19');
  });

  it('retorna a string original quando o formato é desconhecido', () => {
    expect(normalizeDate('amanhã')).toBe('amanhã');
  });

  it('trim antes de avaliar formato dd/MM/yyyy', () => {
    expect(normalizeDate('  19/05/2026  ')).toBe('2026-05-19');
  });
});

describe('sanitizeId', () => {
  it('mantém word chars e hífens, remove o resto', () => {
    expect(sanitizeId('abc-123_xyz')).toBe('abc-123_xyz');
    expect(sanitizeId('id@#$%')).toBe('id');
    expect(sanitizeId(' 123 ')).toBe('123');
  });

  it('retorna string vazia para falsy', () => {
    expect(sanitizeId(null)).toBe('');
    expect(sanitizeId(undefined)).toBe('');
  });
});

describe('tableToObjects', () => {
  it('mapeia linhas para objetos usando headers', () => {
    const rows = [
      { cells: ['João', '40', 'SP'] },
      { cells: ['Maria', '30', 'RJ'] },
    ];
    const result = tableToObjects(rows, ['nome', 'idade', 'estado']);
    expect(result).toEqual([
      { nome: 'João', idade: '40', estado: 'SP' },
      { nome: 'Maria', idade: '30', estado: 'RJ' },
    ]);
  });

  it('aplica cleanText nas células (colapsa espaços)', () => {
    const rows = [{ cells: ['  hello   world  '] }];
    const result = tableToObjects(rows, ['x']);
    expect(result).toEqual([{ x: 'hello world' }]);
  });

  it('substitui null por string vazia (via cleanText)', () => {
    const rows = [{ cells: [null] }];
    const result = tableToObjects(rows, ['x']);
    expect(result).toEqual([{ x: '' }]);
  });
});

describe('redactSensitive', () => {
  it('substitui o valor de campos sensíveis padrão', () => {
    const input = { user: 'alice', password: 'secret123', token: 'abc' };
    expect(redactSensitive(input)).toEqual({
      user: 'alice',
      password: '[REDACTED]',
      token: '[REDACTED]',
    });
  });

  it('aceita lista custom de campos', () => {
    const input = { user: 'alice', secret_field: 'hide-me', visible: 'ok' };
    expect(redactSensitive(input, ['secret_field'])).toEqual({
      user: 'alice',
      secret_field: '[REDACTED]',
      visible: 'ok',
    });
  });

  it('não altera o objeto original (retorna cópia)', () => {
    const input = { password: 'secret' };
    const redacted = redactSensitive(input);
    expect(input.password).toBe('secret');
    expect(redacted.password).toBe('[REDACTED]');
  });

  it('ignora campos não presentes', () => {
    const input = { foo: 'bar' };
    expect(redactSensitive(input)).toEqual({ foo: 'bar' });
  });
});
