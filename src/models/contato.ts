/**
 * Modelo de Contato
 *
 * Representa um contato no sistema Astrea.
 * URL de referência: https://astrea.net.br/#/main/contacts/detail/{id}/data
 *
 * O $id é extraído da URL da página de detalhe do contato.
 * A $pastaDriveUrl é extraída da aba "Documentos" do contato, buscando o documento
 * cujo tipo seja um link do Google Drive com descrição "Pasta Drive", ou um documento
 * de origem "Drive" cujo link aponte para uma pasta (google.com/drive/folders/...).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Sub-tipos auxiliares
// ─────────────────────────────────────────────────────────────────────────────

/** Endereço estruturado de um contato */
export interface EnderecoContato {
  /** Endereço completo em formato texto (como exibido no Astrea) */
  logradouro?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
  cep?: string;
  pais?: string;
  /** Endereço completo concatenado, conforme retornado pela tela */
  enderecoCompleto?: string;
}

/** Número de telefone com tipo */
export interface TelefoneContato {
  /** Ex: "Celular pessoal", "Celular comercial", "Telefone residencial", "Telefone comercial" */
  tipo: string;
  numero: string;
}

/** Endereço de e-mail com tipo */
export interface EmailContato {
  /** Ex: "E-mail pessoal", "E-mail comercial" */
  tipo: string;
  email: string;
}

/** Dados bancários do contato */
export interface ContaBancaria {
  banco?: string;
  agencia?: string;
  conta?: string;
  chavePix?: string;
}

/** Caso/processo vinculado a um documento */
export interface CasoVinculadoDocumento {
  /** ID do caso/processo */
  id: string;
  /** Título do caso/processo */
  titulo: string;
  /**
   * Tipo interno do Astrea:
   * - `CTE_CASE`    → caso (não é processo judicial)
   * - `CTE_LAWSUIT` → processo judicial
   */
  tipo: 'CTE_CASE' | 'CTE_LAWSUIT' | string;
}

/**
 * Documento registrado na aba "Documentos" de um contato no Astrea.
 *
 * Os tipos possíveis de documento (`tipo`) são:
 *  - `DTE_DRIVE`       → pasta ou arquivo no Google Drive
 *  - `DTE_GOOGLE_DOCS` → documento do Google Docs / Google Sheets / etc.
 *  - `DTE_FILE`        → arquivo enviado diretamente (upload)
 *  - `DTE_URL`         → link externo
 */
export interface DocumentoContato {
  /** ID numérico do documento no Astrea */
  id: string;

  /**
   * Tipo do documento:
   * - `DTE_DRIVE`       → Google Drive (pasta ou arquivo)
   * - `DTE_GOOGLE_DOCS` → Google Docs / Sheets / Slides
   * - `DTE_FILE`        → arquivo enviado (upload)
   * - `DTE_URL`         → link externo
   */
  tipo: 'DTE_DRIVE' | 'DTE_GOOGLE_DOCS' | 'DTE_FILE' | 'DTE_URL' | string;

  /** Título / nome exibido na tabela de documentos */
  titulo: string;

  /** Descrição adicional (pode conter o URL para documentos do tipo DTE_URL) */
  descricao?: string;

  /**
   * URL de acesso direto ao documento.
   * Presente para `DTE_DRIVE`, `DTE_GOOGLE_DOCS` e `DTE_URL`.
   * Ausente para `DTE_FILE` (use `urlDownload` nesse caso).
   */
  url?: string;

  /**
   * Endpoint da API do Astrea para download do arquivo.
   * Ex: `/api/v2/storage/download-files/user/{userId}/document/{id}`
   */
  urlDownload?: string;

  /** Nome do usuário responsável pelo documento */
  responsavel?: string;

  /** Data da última edição no formato dd/MM/yyyy */
  ultimaEdicao?: string;

  /**
   * Origem do documento:
   * - `STANDARD_DOCUMENT`       → documento avulso
   * - `STANDARD_DOCUMENT_MODEL` → gerado a partir de um modelo/template
   */
  origem?: 'STANDARD_DOCUMENT' | 'STANDARD_DOCUMENT_MODEL' | string;

  /** Caso ou processo ao qual o documento está vinculado (opcional) */
  caso?: CasoVinculadoDocumento;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entidade principal: Contato
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Contato completo conforme dados disponíveis na tela "Cadastro" do Astrea
 * (aba /data) e na aba "Documentos" para extração da Pasta Drive.
 */
export interface Contato {
  // ── Identificação ──────────────────────────────────────────────────────────
  /** ID numérico do contato, extraído da URL (ex: "6207779269181440") */
  id: string;

  /** Nome completo */
  nome: string;

  /** Apelido / nome fantasia */
  apelido?: string;

  /**
   * Flag que indica se o contato é cliente do escritório
   * (exibido como "TIPO: CLIENTE" na tela).
   */
  isCliente: boolean;

  /** Data de criação do contato no Astrea (ex: "11/06/2025") */
  criadoEm?: string;

  // ── Dados pessoais ─────────────────────────────────────────────────────────
  /** Data de nascimento (ex: "19/05/1979") */
  nascimento?: string;

  /** Idade calculada pelo sistema */
  idade?: number;

  /** Estado civil (ex: "Solteiro", "Casado", "Divorciado", "Viúvo", "União estável") */
  estadoCivil?: string;

  /** Etiquetas / tags atribuídas ao contato */
  etiquetas?: string[];

  /** Origem / indicação (ex: nome de quem indicou o cliente) */
  origem?: string;

  /** Indica se o contato está registrado como falecido */
  falecido?: boolean;

  /** Atividade econômica / profissão */
  atividadeEconomica?: string;

  /** Nome do pai */
  nomePai?: string;

  /** Nome da mãe */
  nomeMae?: string;

  /** Naturalidade (cidade/estado de nascimento) */
  naturalidade?: string;

  /** Nacionalidade */
  nacionalidade?: string;

  /** Comentários / observações gerais */
  comentarios?: string;

  // ── Contato (telefones e e-mails) ──────────────────────────────────────────
  /**
   * Lista de telefones com seus respectivos tipos.
   * Tipos possíveis: "Celular pessoal", "Celular comercial",
   * "Telefone residencial", "Telefone comercial".
   */
  telefones?: TelefoneContato[];

  /**
   * Atalho para o celular pessoal (campo mais comum).
   * Também disponível em `telefones`.
   */
  celularPessoal?: string;

  /** Celular comercial */
  celularComercial?: string;

  /** Telefone residencial (fixo) */
  telefoneResidencial?: string;

  /** Telefone comercial (fixo) */
  telefoneComercial?: string;

  /**
   * Lista de e-mails com seus respectivos tipos.
   * Tipos possíveis: "E-mail pessoal", "E-mail comercial".
   */
  emails?: EmailContato[];

  /** Atalho para o e-mail pessoal */
  emailPessoal?: string;

  /** E-mail comercial */
  emailComercial?: string;

  /** Site / URL do contato */
  site?: string;

  // ── Endereços ──────────────────────────────────────────────────────────────
  /** Endereço residencial estruturado */
  enderecoResidencial?: EnderecoContato;

  /** Endereço comercial estruturado */
  enderecoComercial?: EnderecoContato;

  // ── Documentos de identificação ────────────────────────────────────────────
  /** CPF (Cadastro de Pessoa Física) */
  cpf?: string;

  /** RG (Registro Geral) */
  rg?: string;

  /** CTPS (Carteira de Trabalho e Previdência Social) */
  ctps?: string;

  /** PIS / NIS (Programa de Integração Social) */
  pis?: string;

  /** Título de eleitor */
  tituloEleitor?: string;

  /** CNH (Carteira Nacional de Habilitação) */
  cnh?: string;

  /** Passaporte */
  passaporte?: string;

  /** Certidão de reservista */
  certidaoReservista?: string;

  // ── Dados bancários ────────────────────────────────────────────────────────
  /** Informações bancárias do contato */
  contaBancaria?: ContaBancaria;

  // ── Google Drive ───────────────────────────────────────────────────────────
  /**
   * URL da pasta do Google Drive usada como repositório de documentos do cliente.
   *
   * Extraída da aba "Documentos" do contato no Astrea. A pasta pode aparecer de
   * duas formas:
   *  1. Como um link cujo texto/descrição seja "Pasta Drive" (tipo "link externo").
   *  2. Como um documento de origem "Drive" (ícone do Google Drive) cujo link
   *     aponta para uma pasta (URL contém "google.com/drive/folders/").
   *
   * Exemplo: "https://drive.google.com/drive/folders/1yBQbLF47KHgSEWeQrE_ReAEnoaj3dvZk"
   */
  pastaDriveUrl?: string;

  // ── Documentos ─────────────────────────────────────────────────────────────
  /**
   * Lista completa de documentos registrados na aba "Documentos" do contato.
   *
   * Inclui todos os tipos: arquivos enviados (`DTE_FILE`), pastas e arquivos do
   * Google Drive (`DTE_DRIVE`), documentos do Google Docs (`DTE_GOOGLE_DOCS`) e
   * links externos (`DTE_URL`).
   *
   * Para encontrar rapidamente a pasta Drive, filtre por:
   * `tipo === 'DTE_DRIVE'` ou `url?.includes('drive.google.com/drive/folders')`
   * (equivalente ao campo `pastaDriveUrl`).
   */
  documentos?: DocumentoContato[];
}
