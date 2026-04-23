const ASTREA_APP = 'https://astrea.net.br';

export function urlContato(id: string): string {
  return `${ASTREA_APP}/#/main/contacts/detail/${id}/data`;
}

export function urlCaso(id: string): string {
  return `${ASTREA_APP}/#/main/folders/detail/${id}`;
}
