export interface Usuario {
  id: string;
  nome: string;
  email: string;
  /** Apelido/nickname do usuario no escritorio. */
  apelido?: string;
  foto?: string;
  admin?: boolean;
  status?: string;
  perfil?: string;
  /** ID do contato associado ao usuario. */
  contatoId?: string;
}
