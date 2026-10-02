// The profile photo (v0.2.2, spec 2026-10-01-foto-de-perfil §2).
// Spread into pt-BR.ts; profile.en.ts must have exactly the same keys.
export const profile = {
  'profile.photo.title': 'Foto de perfil',
  'profile.photo.change': 'Alterar foto',
  'profile.photo.remove': 'Remover foto',
  'profile.photo.hint': 'A mesma foto vale para todos os servidores. PNG, JPEG, WebP ou GIF, até 10 MB; GIFs animados continuam animados.',
  'profile.photo.unreadable': 'Não deu para abrir essa imagem.',

  'profile.crop.title': 'Editar imagem',
  'profile.crop.frame': 'Arraste a imagem para enquadrar. As setas também movem.',
  'profile.crop.zoom': 'Aproximar',
  'profile.crop.reset': 'Redefinir',
  'profile.crop.apply': 'Aplicar',
  'profile.crop.applying': 'Aplicando…',
  'profile.crop.tooLarge': 'GIF grande demais. Tente um mais curto ou com menos cores.',

  // The server icon (v0.3.2, spec 2026-10-01-icone-do-servidor): the same picker and crop modal.
  'serverIcon.title': 'Ícone do servidor',
  'serverIcon.change': 'Alterar ícone',
  'serverIcon.remove': 'Remover ícone',
  'serverIcon.hint': 'Aparece para todos no trilho de servidores e no cabeçalho. PNG, JPEG, WebP ou GIF, até 10 MB; GIFs animados continuam animados. Sem ícone, as iniciais do nome.',

  // The profile card (v0.4.2, spec 2026-10-02-cartao-de-perfil).
  'profileCard.label': 'Perfil de {name}',
  'profileCard.more': 'Mais opções',
  'profileCard.memberSince': 'Membro desde',
  'profileCard.removeRole': 'Tirar o cargo {role}',
  'profileCard.addRole': 'Adicionar cargo',
  'profileCard.addRoleTo': 'Cargos para dar a {name}',
  'profileCard.copyId': 'Copiar ID do usuário',
} as const;
