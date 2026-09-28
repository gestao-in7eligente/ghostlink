// Identity: backup (.ghostkey), import and delete (spec §3.1, §3.4, §11.1 screen 7).
export const identity = {
  'identity.settings.title': 'Identidade',
  'identity.settings.intro':
    'Sua identidade é uma chave guardada só neste computador. Sem um backup, perder ou formatar o computador é perder a identidade: você deixa de ser dono dos seus servidores e precisa de convites de novo.',
  'identity.settings.open': 'Identidade e backup',

  'identity.export.title': 'Exportar backup',
  'identity.export.body': 'Salva um arquivo .ghostkey protegido por senha. Guarde o arquivo e a senha em lugares diferentes.',
  'identity.export.password': 'Senha do backup',
  'identity.export.confirm': 'Repita a senha',
  'identity.export.hint': 'Pelo menos 8 caracteres. Sem a senha, o arquivo não pode ser aberto por ninguém, nem por você.',
  'identity.export.submit': 'Escolher onde salvar',
  'identity.export.working': 'Protegendo o arquivo…',
  'identity.export.saved': 'Backup salvo: {file}',
  'identity.export.short': 'A senha precisa de pelo menos 8 caracteres.',
  'identity.export.long': 'A senha é longa demais.',
  'identity.export.mismatch': 'As duas senhas não são iguais.',

  'identity.import.title': 'Importar backup',
  'identity.import.body': 'Restaura uma identidade de um arquivo .ghostkey, por exemplo de outro computador.',
  'identity.import.pick': 'Escolher arquivo…',
  'identity.import.picked': 'Arquivo: {file}',
  'identity.import.password': 'Senha do backup',
  'identity.import.submit': 'Importar',
  'identity.import.working': 'Abrindo o backup…',
  'identity.import.confirm1':
    'Importar substitui a identidade atual deste computador. Com a identidade atual, você perde o acesso aos servidores em que entrou com ela, a não ser que tenha um backup dela.',
  'identity.import.confirm1Button': 'Entendi, continuar',
  'identity.import.confirm2': 'Última confirmação: substituir a identidade agora? O arquivo antigo fica guardado como identity.bin.bak-….',
  'identity.import.confirm2Button': 'Substituir identidade',
  'identity.import.done': 'Identidade restaurada.',

  'identity.delete.title': 'Apagar deste computador',
  'identity.delete.body': 'Remove a sua identidade deste computador. Sem um backup, ela se perde para sempre.',
  'identity.delete.exportFirst': 'Exportar um backup antes',
  'identity.delete.start': 'Apagar identidade',
  'identity.delete.confirm1':
    'Sem a identidade, você deixa de ser reconhecido pelos servidores: perde a posse dos seus servidores e precisa de convites para voltar. Exporte um backup antes se quiser guardá-la.',
  'identity.delete.confirm1Button': 'Quero apagar',
  'identity.delete.confirm2': 'Última confirmação: apagar a identidade deste computador agora?',
  'identity.delete.confirm2Button': 'Apagar agora',

  'identity.onboarding.export': 'Exportar agora',
  'identity.onboarding.import': 'Já tenho um backup',

  'errors.BACKUP_INVALID': 'Este arquivo não é um backup .ghostkey válido.',
} as const;
