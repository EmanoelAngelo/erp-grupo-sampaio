/**
 * Atalhos do PDV — a ajuda na tela e o comportamento precisam ser a mesma
 * coisa.
 *
 * O DEFEITO QUE ORIGINOU ISTO
 *
 * A ajuda declarava oito atalhos; o handler tratava seis. F7 e F12 tinham
 * botão na tela mas nenhuma tecla, e F7 ainda mostrava "Venda em espera." sem
 * guardar venda nenhuma. Operador de balcão aprende atalho pela lista da
 * tela — quando a tecla não faz nada, ele para de confiar no sistema inteiro,
 * inclusive no que funciona.
 *
 * Este arquivo cobra a EQUIVALÊNCIA: toda tecla declarada é tratada, e toda
 * tecla tratada é declarada.
 */
import { describe, expect, it } from 'vitest';
import { PDV_SHORTCUT_KEYS, PDV_TECLAS_DO_SISTEMA } from '../pdvTypes';
// O `?raw` do Vite entrega a fonte como texto. Ler por caminho de arquivo não
// funciona: no ambiente jsdom do vitest, `import.meta.url` não é um `file:`.
import FONTE from '../PdvPage.tsx?raw';
import FONTE_PAGAMENTO from '@/components/gs/PagamentoDialog.tsx?raw';

/** Teclas do mapa do handler, lidas da própria fonte. */
function teclasDoHandler(): string[] {
  const bloco = FONTE.split('const map: Record<string, () => void> = {')[1]?.split('};')[0] ?? '';
  return [...bloco.matchAll(/^\s{8}(F\d+):/gm)].map((m) => m[1]);
}

/** Teclas declaradas na ajuda (só as de função; "1 a 5" e Esc são do modal). */
function teclasDaAjuda(): string[] {
  const bloco = FONTE.split('const SHORTCUTS = [')[1]?.split('];')[0] ?? '';
  return [...bloco.matchAll(/\['(F\d+)',/g)].map((m) => m[1]);
}

describe('a ajuda e o handler concordam', () => {
  it('toda tecla declarada na ajuda é tratada pelo handler', () => {
    const tratadas = new Set(teclasDoHandler());
    for (const tecla of teclasDaAjuda()) {
      // F7 e F12 estavam aqui e não no handler: apertar não fazia nada.
      expect(tratadas.has(tecla), `${tecla} está na ajuda mas não no handler`).toBe(true);
    }
  });

  it('toda tecla tratada pelo handler está declarada na ajuda', () => {
    const declaradas = new Set(teclasDaAjuda());
    for (const tecla of teclasDoHandler()) {
      expect(declaradas.has(tecla), `${tecla} funciona mas não aparece na ajuda`).toBe(true);
    }
  });

  it('a constante exportada bate com o handler — é ela que o resto do app lê', () => {
    expect([...PDV_SHORTCUT_KEYS].sort()).toEqual([...teclasDoHandler()].sort());
  });

  it('cobre as teclas que o balcão usa de verdade', () => {
    for (const tecla of ['F2', 'F3', 'F4', 'F6', 'F7', 'F8', 'F9', 'F10']) {
      expect(PDV_SHORTCUT_KEYS).toContain(tecla);
    }
  });
});

/**
 * O balcão roda num desktop, dentro de um navegador.
 *
 * F5 abria o pagamento e F12 a observação — as duas com `preventDefault`. Quem
 * passa o dia no PDV perdeu recarregar a página e abrir as ferramentas do
 * navegador, e não havia como saber por quê: a tecla simplesmente fazia outra
 * coisa. Pagamento foi para F10, observação para Alt+O.
 */
describe('teclas do sistema operacional continuam sendo do sistema', () => {
  it('F5, F11 e F12 não são tratadas pelo PDV', () => {
    const tratadas = new Set(teclasDoHandler());
    for (const tecla of PDV_TECLAS_DO_SISTEMA) {
      expect(tratadas.has(tecla), `${tecla} voltou a ser sequestrada pelo PDV`).toBe(false);
    }
  });

  it('nem aparecem na ajuda, para ninguém aprender errado', () => {
    const declaradas = new Set(teclasDaAjuda());
    for (const tecla of PDV_TECLAS_DO_SISTEMA) {
      expect(declaradas.has(tecla)).toBe(false);
    }
  });

  it('a constante exportada também não as contém', () => {
    for (const tecla of PDV_TECLAS_DO_SISTEMA) {
      expect(PDV_SHORTCUT_KEYS).not.toContain(tecla);
    }
  });

  it('o pagamento não ficou sem tecla — mudou de lugar', () => {
    expect(PDV_SHORTCUT_KEYS).toContain('F10');
    expect(FONTE).toContain('F10: openPayment');
  });

  it('a observação continua existindo, em Alt+O', () => {
    expect(FONTE).toContain("e.altKey && (e.key === 'o' || e.key === 'O')");
    expect(FONTE).toContain('Observações (Alt+O)');
  });
});

describe('F7 não pode voltar a mentir', () => {
  it('o botão Aguardar chama a ação real, não uma mensagem', () => {
    // A versão antiga era:
    //   onClick={() => setMessage({ tone: 'ok', text: 'Venda em espera.' })}
    expect(FONTE).toContain('onClick={aguardarVenda}');
    expect(FONTE).not.toContain("text: 'Venda em espera.'");
  });

  it('a ação usa o módulo de espera, que persiste o carrinho', () => {
    expect(FONTE).toContain('emEspera.guardar(');
  });
});

describe('Observações e F3', () => {
  it('Observações usa a ação compartilhada com a tecla', () => {
    expect(FONTE).toContain('onClick={editarObservacao}');
  });

  it('o caixa tem tecla e botão — avisar sem oferecer o conserto não basta', () => {
    expect(FONTE).toContain('Abrir caixa (F3)');
    expect(teclasDoHandler()).toContain('F3');
  });
});

/**
 * A DOUTRINA DAS TECLAS VALE PARA O DIÁLOGO DE PAGAMENTO TAMBÉM.
 *
 * O PDV tirou F5 do próprio mapa e ganhou teste para isso — e o
 * `PagamentoDialog`, que é a tela por onde todo dinheiro passa, continuou
 * sequestrando a tecla. Pior: só quando o Finalizar já podia fechar. Em
 * pagamento dividido, que é quando o botão fica desabilitado, o `preventDefault`
 * não acontecia e o navegador recarregava com o carrinho montado.
 *
 * Esta varredura fecha o buraco: a regra passa a valer nos dois arquivos.
 */
describe('o diálogo de pagamento obedece à mesma doutrina', () => {
  it('não trata F5 — a tecla é do navegador', () => {
    expect(FONTE_PAGAMENTO).not.toMatch(/e\.key === 'F5'/);
    expect(FONTE_PAGAMENTO).not.toContain('Finalizar (F5)');
  });

  it('finaliza em F10, a mesma tecla que abriu o pagamento', () => {
    expect(FONTE_PAGAMENTO).toMatch(/e\.key === 'F10'/);
    expect(FONTE_PAGAMENTO).toContain('Finalizar (F10)');
  });

  it('a escolha do meio exige Alt — senão o dígito é do campo de valor', () => {
    /*
      O ouvinte é de captura na janela e o foco vive no campo de valor. Sem o
      Alt, "2" escolheria débito E somaria um 2 ao número em digitação — foi
      assim que o atalho prometido na ajuda nunca funcionou e ainda inflava o
      lançamento.
    */
    expect(FONTE_PAGAMENTO).toContain('if (!e.altKey) return;');
    const ajuda = FONTE.split('const SHORTCUTS = [')[1]?.split('];')[0] ?? '';
    expect(ajuda).toContain('Alt+1 a Alt+');

    /*
      E a lista não pode citar meio que a loja não tem: o crediário está
      desligado no catálogo do servidor (`active: false`), nunca é devolvido
      por `/payment-methods` e não vira botão nenhum. A ajuda ensinava um meio
      de pagamento que a loja não oferece — e venda a prazo é justamente o que
      um cliente pede em voz alta no balcão.
    */
    expect(ajuda).not.toMatch(/crediário/i);
  });
});
