// The owner's notice when the connected server is behind the app (v0.2.2, spec 2026-10-01 §5).
// Spread into pt-BR.ts; serverUpdate.en.ts must have exactly the same keys.
export const serverUpdate = {
  'serverUpdate.label': 'Atualização do servidor',
  'serverUpdate.waiting': 'Este servidor está na {version}. Ele será atualizado para a {target} quando ninguém estiver em chamada.',
  'serverUpdate.updating': 'Atualizando este servidor para a {target}. Quem estiver conectado reconecta sozinho.',
  'serverUpdate.failed': 'Este servidor está na {version}. A atualização para a {target} não terminou; o GhostLink tenta de novo daqui a pouco.',
  'serverUpdate.railwayDisconnected':
    'Este servidor está na {version}. Para atualizá-lo para a {target}, conecte o Railway de novo em Criar um servidor → Na nuvem (Railway).',
  'serverUpdate.manual': 'Este servidor está na {version}. Atualize para a {target}',
  'serverUpdate.addingAgent': 'Adicionando o {agent} a este servidor. Quem estiver conectado reconecta sozinho.',
  'serverUpdate.howTo': 'veja como',
  'serverUpdate.updateNow': 'Atualizar agora',
  'serverUpdate.confirm.title': 'Atualizar o servidor agora?',
  'serverUpdate.confirm.body': 'Quem estiver em chamada cai por alguns segundos.',
  'serverUpdate.dismiss': 'Fechar aviso',
} as const;
