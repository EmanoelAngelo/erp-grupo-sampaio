/**
 * O status da nota de entrada — uma fonte de verdade.
 *
 * ## Por que este arquivo existe
 *
 * O valor vivia como texto literal espalhado em quatro lugares, e em DUAS
 * línguas. `NfeImportService` gravava `'recebida'`; três consultas procuravam
 * `'received'`.
 *
 * Nenhuma delas casava. Na prática: a mercadoria chegava, o estoque subia e o
 * financeiro nascia — mas o pedido de compra continuava "enviado" para sempre,
 * com `received_quantity` zerado, e o histórico de compras do fornecedor vinha
 * vazio. Quem comprava não tinha como saber o que já chegou, e acabava pedindo
 * de novo.
 *
 * ## Por que a suíte não pegou
 *
 * Os testes fabricavam a nota com `INSERT` direto, escrevendo `'received'` —
 * o valor que a consulta esperava e que a produção nunca grava. O teste
 * concordava com o defeito em vez de cobrar o comportamento.
 *
 * Agora quem escreve e quem lê usam a MESMA constante. Um erro de digitação
 * vira erro de compilação, e não um relatório vazio meses depois.
 */

/**
 * Importada do XML, ainda não conferida. Não conta como compra.
 *
 * ## O valor aqui é `'conferencia'`, e já foi `'imported'`
 *
 * Quando este arquivo nasceu, ele consolidou o status RECEBIDO e errou o
 * IMPORTADO: declarou `'imported'` porque era o `DEFAULT` da coluna no schema.
 * Só que `importNfe` sempre informa o valor no `INSERT`, então o default nunca
 * chegou a se aplicar — a produção grava `'conferencia'` desde o primeiro dia.
 *
 * O resultado foi uma constante decorativa: nada a escrevia, nada a lia. Não
 * quebrou porque nenhuma consulta filtra por este estado ainda. Mas a
 * armadilha estava armada e era a mesma de sempre — quem escrevesse
 * `WHERE status = NOTA_IMPORTADA` receberia zero linhas para sempre, que é
 * exatamente o defeito que este arquivo existe para impedir.
 *
 * Corrigir pelo outro lado (fazer a produção gravar `'imported'`) exigiria
 * migrar as notas que já existem no banco da loja para ganhar nada: o nome
 * interno do estado não aparece em tela nenhuma.
 */
export const NOTA_IMPORTADA = 'conferencia' as const;

/**
 * Conferida e recebida: o estoque entrou e o financeiro nasceu.
 *
 * É este valor que responde por "o que já chegou" no pedido de compra e no
 * histórico do fornecedor.
 */
export const NOTA_RECEBIDA = 'recebida' as const;

/**
 * Entrada confirmada e depois DESFEITA — o espelho do recebimento (GAP-V20).
 *
 * O estado existe porque o erro existe: o XML do irmão da outra empresa, o
 * arquivo duplicado com chave diferente. Antes dele, corrigir uma confirmação
 * errada eram dois gestos desconectados (ajuste de estoque + cancelamento do
 * lançamento), sem vínculo entre si nem com a nota — e o histórico do
 * fornecedor continuava contando a compra.
 *
 * A nota estornada é documento MORTO: não se confere, não se reconfirma, não
 * se amarra a pedido, não conta no histórico do fornecedor nem no recebido do
 * pedido (todas as consultas filtram por NOTA_RECEBIDA). Os movimentos de
 * estoque dela NÃO são apagados — o estorno grava o movimento contrário, e o
 * razão conta a história inteira.
 */
export const NOTA_ESTORNADA = 'estornada' as const;

export type InboundNoteStatus =
  | typeof NOTA_IMPORTADA
  | typeof NOTA_RECEBIDA
  | typeof NOTA_ESTORNADA;
