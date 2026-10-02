# GhostLink — Menu do canal de texto (clique direito, como o Discord)

Aprovado pelo dono em 2026-10-02, a partir de um print do menu do Discord num canal de texto. Escolha: **sem categorias por enquanto** (o "Move to" fica de fora). Sai na **v0.5.0**, junto com o Ghost DJ.

## 1. Onde abre

Clique direito, tecla de menu ou Shift+F10 num **canal de texto** da barra lateral do servidor. Canais de voz continuam como hoje.

## 2. Itens, em ordem (cada um só aparece quando faz sentido)

1. **Marcar como lida** (`channel.read`); desativado quando não há nada novo.
2. *Separador.* **Convite para o canal**: abre o convite do servidor que já existe (quem pode criar convites); o link leva o canal junto, e quem entrar por ele cai direto nesse canal se puder vê-lo.
3. **Fixe o Canal no Topo** / **Desafixar do topo**: o canal sobe para o topo da lista de canais de texto, só para mim (guardado no PC, por servidor). Os fixados ficam na ordem em que foram fixados.
4. **Copiar link**: `ghostlink://channel/<serverKeyId>/<channelId>`. Abrir o link no app leva ao servidor salvo e seleciona o canal; quem não é membro vê "Você não está nesse servidor".
5. *Separador.* **Silenciar canal ›** 15 min, 1 h, 3 h, 8 h, 24 h, Até eu reativar (vira **Reativar canal** enquanto silenciado): sem notificação nenhuma desse canal, nome esmaecido na lista; menções continuam com o contador.
6. **Config. de notificação ›** com a escolha atual embaixo do nome: **Padrão do servidor** (mostra qual é), **Todas as mensagens**, **Só @menções**, **Nada**. Guardado no PC, por canal; vale sobre o modo do servidor (v0.4.2).
7. *Separador, só para quem pode gerenciar canais.* **Editar canal** (abre Configurações do servidor > Canais nesse canal), **Duplicar canal** (abre "Criar canal" preenchido com nome "‹nome›-copia", tópico, privado e cargos), **Criar canal de texto**, **Excluir canal** (vermelho, com a confirmação de hoje).
8. *Separador.* **Copiar ID do canal**, com o ícone de ID.

Fora: "Move to" (o GhostLink ainda não tem categorias).

## 3. Testes (enxutos)

- Quais itens aparecem (permissões, não lida, silenciado, fixado).
- O modo de notificação efetivo: canal silenciado > modo do canal > modo do servidor; o silêncio com prazo vence sozinho.
- A ordem dos fixados e o link `ghostlink://channel/...` (ler, abrir, servidor desconhecido).
