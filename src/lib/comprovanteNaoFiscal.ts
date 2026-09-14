/**
 * O COMPROVANTE NÃO FISCAL montado no próprio navegador.
 *
 * O cupom da venda é desenhado no servidor (`PrintRenderer.renderSale`). Com o
 * servidor da loja fora de alcance a venda fica guardada na fila deste
 * computador (`offlineQueue.ts`) — e o cliente continua na frente, esperando o
 * papel. Este é o papel desse momento: o que a tela já sabe (itens, total,
 * pagamentos, troco), formatado para a térmica comum (58/80 mm) e dizendo com
 * todas as letras o que ele é:
 *
 *   COMPROVANTE NÃO FISCAL — VENDA OFFLINE, PENDENTE DE SINCRONIZAÇÃO
 *
 * Ele NUNCA se apresenta como NFC-e: não tem chave, não tem QR, não tem
 * protocolo — autorização da SEFAZ não existe sem conexão, e o papel não finge.
 */
export interface DadosDoComprovante {
  loja: string;
  /*
    CNPJ, ENDEREÇO E TELEFONE DA LOJA (F-cupom-fiscal-20#reauditoria).

    O comprovante offline saía só com o nome fantasia: o cliente levava um papel
    que não dizia de qual CNPJ comprou nem para onde voltar. Vêm da resposta da
    gaveta (`loja`, a mesma leitura do cabeçalho do cupom do servidor), guardada
    enquanto o servidor respondia. Opcionais: um caixa que nunca falou com o
    servidor não tem o que guardar, e o papel sai sem as linhas — como o cupom.
  */
  cnpj?: string | null;
  endereco?: string | null;
  telefone?: string | null;
  quando: Date;
  /** "Venda #123" — ou, offline, a identificação local da venda guardada. */
  identificacao: string;
  itens: { descricao: string; quantidade: number; unitarioCents: number; totalCents: number }[];
  subtotalCents: number;
  descontoCents: number;
  acrescimoCents: number;
  totalCents: number;
  pagamentos: { rotulo: string; valorCents: number }[];
  trocoCents: number;
  offline: boolean;
  /** Largura do papel: 80 mm (padrão) ou 58 mm. */
  larguraMm?: 58 | 80;
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function brl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function qtd(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

/** O meio de pagamento como o cliente lê — o mesmo rótulo do cupom do servidor. */
const ROTULO_DO_MEIO: Record<string, string> = {
  dinheiro: 'Dinheiro',
  pix: 'PIX',
  debito: 'Cartão de débito',
  credito: 'Cartão de crédito',
  crediario: 'Crediário',
  vale: 'Vale',
  boleto: 'Boleto',
  transferencia: 'Transferência',
};
export function rotuloDoMeio(metodo: string): string {
  return ROTULO_DO_MEIO[metodo] ?? metodo;
}

export function htmlDoComprovanteNaoFiscal(d: DadosDoComprovante): string {
  const largura = d.larguraMm ?? 80;
  const quando = d.quando.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const linhas = d.itens
    .map(
      (i) => `<tr><td colspan="2">${esc(i.descricao)}</td></tr>
      <tr><td>${esc(qtd(i.quantidade))} x ${brl(i.unitarioCents)}</td><td class="r b">${brl(i.totalCents)}</td></tr>`,
    )
    .join('');
  const meios = d.pagamentos
    .map((p) => `<tr><td>${esc(p.rotulo)}</td><td class="r">${brl(p.valorCents)}</td></tr>`)
    .join('');
  // As mesmas linhas, na mesma ordem, do cabeçalho do cupom do servidor.
  const linhasDaLoja = [
    d.cnpj ? `CNPJ ${esc(d.cnpj)}` : '',
    d.endereco ? esc(d.endereco) : '',
    d.telefone ? `Fone ${esc(d.telefone)}` : '',
  ].filter(Boolean);
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Comprovante não fiscal</title>
<style>
  @page { size: ${largura}mm auto; margin: 2mm; }
  * { box-sizing: border-box; }
  body { margin: 0 auto; width: ${largura - 4}mm; font-family: "Courier New", monospace; font-size: ${largura === 58 ? 10 : 12}px; color: #000; }
  h1 { font-size: 1.15em; text-align: center; margin: 0 0 1mm; }
  .aviso { text-align: center; font-weight: bold; border: 1px solid #000; padding: 1mm; margin: 1mm 0; }
  table { width: 100%; border-collapse: collapse; }
  td { vertical-align: top; padding: 0.3mm 0; }
  .r { text-align: right; white-space: nowrap; }
  .b { font-weight: bold; }
  .total td { font-size: 1.2em; font-weight: bold; }
  hr { border: 0; border-top: 1px dashed #000; margin: 1.5mm 0; }
  .rodape { text-align: center; margin-top: 2mm; }
  .sub { text-align: center; margin: 0 0 1mm; }
</style></head><body>
  <h1>${esc(d.loja)}</h1>
  ${linhasDaLoja.length > 0 ? `<p class="sub">${linhasDaLoja.join('<br>')}</p>` : ''}
  <div class="aviso">COMPROVANTE NÃO FISCAL</div>
  ${d.offline ? '<div class="aviso">VENDA OFFLINE — PENDENTE DE SINCRONIZAÇÃO</div>' : ''}
  <table><tr><td>${esc(d.identificacao)}</td><td class="r">${esc(quando)}</td></tr></table>
  <hr>
  <table>${linhas}</table>
  <hr>
  <table>
    <tr><td>Subtotal</td><td class="r">${brl(d.subtotalCents)}</td></tr>
    ${d.descontoCents > 0 ? `<tr><td>Desconto</td><td class="r">- ${brl(d.descontoCents)}</td></tr>` : ''}
    ${d.acrescimoCents > 0 ? `<tr><td>Acréscimo</td><td class="r">+ ${brl(d.acrescimoCents)}</td></tr>` : ''}
    <tr class="total"><td>TOTAL</td><td class="r">${brl(d.totalCents)}</td></tr>
  </table>
  <hr>
  <table>${meios}
    ${d.trocoCents > 0 ? `<tr class="b"><td>TROCO</td><td class="r">${brl(d.trocoCents)}</td></tr>` : ''}
  </table>
  <p class="rodape">Documento sem valor fiscal.<br>Não substitui a NFC-e.<br>Obrigado pela preferência!</p>
</body></html>`;
}

/**
 * Abre o comprovante numa janela e chama a impressão do sistema (a térmica
 * instalada no Windows aparece no diálogo). Precisa rodar DENTRO do clique:
 * janela aberta depois de um `await` é bloqueada como pop-up.
 */
export function imprimirComprovanteNaoFiscal(html: string): boolean {
  const janela = window.open('', '_blank', 'width=420,height=640');
  if (!janela) return false;
  janela.document.open();
  janela.document.write(html);
  janela.document.close();
  /*
    A JANELA FECHA QUANDO A IMPRESSÃO TERMINA (F-cupom-fiscal-20#reauditoria).

    Ficava aberta atrás do PDV depois de cada comprovante: numa manhã sem
    servidor, uma janela por venda, e o caixa descobria a pilha ao trocar de
    tela. `afterprint` vem tanto de imprimir quanto de cancelar o diálogo — nos
    dois casos o papel já não precisa da janela. Registrado ANTES do `print()`,
    que em alguns navegadores só retorna depois do diálogo.
  */
  janela.addEventListener('afterprint', () => janela.close());
  janela.focus();
  janela.print();
  return true;
}
