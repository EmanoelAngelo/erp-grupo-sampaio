/**
 * A ETIQUETA DESTE PRODUTO, dentro do cadastro.
 *
 * Cadastrar e etiquetar são o mesmo gesto na loja: o produto chegou, ganhou
 * código, precisa do adesivo. Aqui se escolhe o MODELO da loja, a quantidade
 * (10 unidades que entraram → 10 etiquetas), confere a prévia e imprime.
 *
 * Imprimir etiqueta NÃO é entrada de estoque: a folha é desenho, e reimprimir
 * não muda saldo nenhum. A entrada de mercadoria é na aba Estoque (ou pela
 * nota de entrada).
 */
import { useEffect, useState } from 'react';
import { Button, Card } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type ModeloDeEtiqueta } from '@/lib/api/core';

const ROTULO = 'text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]';
const CAIXA =
  'h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] ' +
  'bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)]';

/** O teto por impressão — o mesmo do servidor. */
const TETO = 200;

/**
 * O que foi digitado, conferido: inteiro de 1 a 200, ou nulo enquanto não for.
 *
 * DEFEITO QUE ISTO CORRIGE: o campo guardava NÚMERO e trocava o vazio por 1 na
 * hora (`Number('') || 1`). Quem apagava o "1" para digitar 30 via o campo
 * voltar a "1" com o cursor depois dele — e o 30 virava 130. "Imprimir 130
 * etiqueta(s)" passava despercebido, e saíam 130 adesivos de rolo. Agora o
 * campo guarda o TEXTO: pode ficar vazio enquanto se digita, e o botão só
 * libera com um número válido.
 */
function lerQuantidade(texto: string): number | null {
  const t = texto.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= TETO ? n : null;
}

type RespostaDaFolha = Awaited<ReturnType<typeof coreApi.labelSheet>>;

/**
 * O que a folha saiu com problema — dito ANTES de a pessoa colar o adesivo.
 *
 * DEFEITO QUE ISTO CORRIGE: a rota da folha devolve `semPreco`, `promocoes` e
 * `codigosSemDesenho`, e a tela de Etiquetas mostra os três — mas a etiqueta
 * do CADASTRO ignorava todos. O produto recém-criado por nota nasce com preço
 * zero: a etiqueta saía com R$ 0,00, ia para a prateleira, e o caixa recusava
 * a venda na frente do cliente. Na promoção, o adesivo saía com o preço
 * promocional e ninguém era avisado de que ele fica errado quando ela acaba.
 * E o aviso de "sem código" SOBRESCREVIA o erro do pop-up bloqueado: a pessoa
 * lia só um dos dois. Agora cada problema é uma linha própria, sem apagar o
 * erro nem o sucesso.
 */
function problemasDaFolha(r: RespostaDaFolha): string[] {
  const lista = (nomes: string[]) => nomes.slice(0, 5).join(', ');
  const problemas: string[] = [];
  if (r.semPreco?.length) {
    problemas.push(
      // "sai", e não "saiu": com o pop-up bloqueado nada foi impresso, e a tela
      // dizia ao mesmo tempo "nada foi impresso" e "a etiqueta saiu com R$ 0,00".
      `Sem preço: ${lista(r.semPreco)} — a etiqueta sai com R$ 0,00 e o caixa vai recusar a venda. `
        + 'Defina o preço no cadastro e imprima de novo.',
    );
  }
  if (r.promocoes?.length) {
    problemas.push(
      `Preço promocional: ${lista(r.promocoes)} — a etiqueta leva o preço da promoção e fica errada quando a promoção acabar. `
        + 'Reimprima a etiqueta nesse dia.',
    );
  }
  if (r.semCodigo?.length) {
    problemas.push(
      'Este produto não tem código de barras e o seu acesso não inclui gerar código no cadastro: a etiqueta sai sem barras. '
        + 'Peça a quem cuida do cadastro para gerar o código.',
    );
  }
  for (const p of r.codigosSemDesenho ?? []) {
    problemas.push(`O código de barras não sai em barras: ${p.motivo}`);
  }
  return problemas;
}

export function EtiquetaDoProduto({
  productId,
  estoque,
  onImpresso,
}: {
  productId: string;
  estoque?: number | null;
  /**
   * Chamado depois de gerar a folha, com o código de barras que o produto
   * GANHOU nela (nulo se já tinha). O formulário do cadastro recarrega com
   * isto — sem recarregar, o campo "EAN / GTIN" continuava vazio e o botão
   * "Gerar código de barras" seguia oferecendo o que já existia.
   */
  onImpresso?: (resultado: { codigoGerado: string | null }) => void;
}) {
  const [modelos, setModelos] = useState<ModeloDeEtiqueta[] | null>(null);
  const [modeloId, setModeloId] = useState('');
  const [quantidadeTexto, setQuantidadeTexto] = useState('1');
  const [previa, setPrevia] = useState<string>('');
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [problemas, setProblemas] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const quantidade = lerQuantidade(quantidadeTexto);

  useEffect(() => {
    void coreApi
      .labelTemplates()
      .then((r) => {
        setModelos(r.items);
        const padrao = r.items.find((m) => m.isDefault) ?? r.items[0];
        if (padrao) setModeloId(padrao.id);
      })
      .catch((err) => {
        setModelos([]);
        setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar os modelos de etiqueta.');
      });
  }, []);

  useEffect(() => {
    if (!modeloId) return;
    const t = setTimeout(() => {
      coreApi
        .previewLabelTemplate({ templateId: modeloId, productId, quantity: Math.min(quantidade ?? 1, 12) })
        .then((r) => setPrevia(r.html))
        .catch(() => setPrevia(''));
    }, 300);
    return () => clearTimeout(t);
  }, [modeloId, productId, quantidade]);

  /** No blur, o que passou do teto vira o teto, e zero vira 1; vazio fica vazio (e o botão travado). */
  function normalizar() {
    const t = quantidadeTexto.trim();
    if (!/^\d+$/.test(t)) return;
    setQuantidadeTexto(String(Math.max(1, Math.min(TETO, Number(t)))));
  }

  async function imprimir() {
    setErro(null);
    setAviso(null);
    setProblemas([]);
    if (quantidade === null) {
      setErro(`Informe a quantidade de etiquetas: um número de 1 a ${TETO}.`);
      return;
    }
    setBusy(true);
    // A janela abre DENTRO do clique: depois do await o navegador a bloqueia como pop-up.
    const janela = window.open('', '_blank');
    try {
      const r = await coreApi.labelSheet({ templateId: modeloId, items: [{ productId, quantity: quantidade }] });
      const gerado = r.codigosGerados?.find((c) => c.productId === productId)?.barcode ?? null;
      const sobreOCodigo = gerado ? ` Este produto ganhou o código de barras ${gerado}.` : '';
      if (janela) {
        janela.document.open();
        janela.document.write(r.html);
        janela.document.close();
        janela.focus();
        janela.print();
        setAviso(`${r.etiquetas} etiqueta(s) enviada(s) para impressão. O estoque não muda.${sobreOCodigo}`);
      } else {
        // O sucesso só é dito quando HOUVE janela: antes a tela mostrava, ao
        // mesmo tempo, o erro do pop-up e "enviadas para impressão".
        setErro(
          'O navegador bloqueou a janela de impressão: nada foi impresso. Libere pop-ups para este endereço e '
            + `clique em Imprimir de novo.${sobreOCodigo}`,
        );
      }
      setProblemas(problemasDaFolha(r));
      onImpresso?.({ codigoGerado: gerado });
    } catch (err) {
      janela?.close();
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível gerar as etiquetas.');
    } finally {
      setBusy(false);
    }
  }

  const noEstoque = typeof estoque === 'number' && estoque > 0 ? Math.round(estoque) : 0;

  return (
    <Card
      title="Etiqueta"
      subtitle="Imprimir etiqueta não é entrada de estoque: reimprimir não muda o saldo. A entrada é na aba Estoque ou pela nota."
    >
      {erro && (
        <p role="alert" className="mb-3 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {aviso && (
        <p role="status" className="mb-3 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">
          {aviso}
        </p>
      )}
      {problemas.length > 0 && (
        <ul
          data-testid="problemas-da-etiqueta"
          className="mb-3 pl-8 pr-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[var(--gs-text)] text-[length:var(--gs-text-sm)]"
        >
          {problemas.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {modelos !== null && modelos.length === 0 ? (
        <p className="m-0 text-[length:var(--gs-text-sm)]">
          A loja ainda não tem modelo de etiqueta.{' '}
          <a href="/sistema/etiquetas" className="font-semibold text-[var(--gs-purple-800)]">
            Criar o primeiro em Produtos › Etiquetas
          </a>
          .
        </p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-5">
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className={ROTULO}>Modelo</span>
              <select value={modeloId} onChange={(e) => setModeloId(e.target.value)} aria-label="Modelo de etiqueta" className={CAIXA}>
                {(modelos ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} — {m.widthMm} × {m.heightMm} mm, {m.columns} col.
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={ROTULO}>Quantidade de etiquetas</span>
              <input
                type="text"
                inputMode="numeric"
                value={quantidadeTexto}
                onChange={(e) => setQuantidadeTexto(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
                onBlur={normalizar}
                aria-label="Quantidade de etiquetas"
                aria-invalid={quantidade === null}
                className={CAIXA}
              />
              {quantidade === null && (
                <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-danger)]">
                  Informe a quantidade: de 1 a {TETO} etiquetas.
                </span>
              )}
            </label>
            {noEstoque > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setQuantidadeTexto(String(Math.min(TETO, noEstoque)))}>
                Uma por unidade em estoque ({noEstoque}{noEstoque > TETO ? `, limitado a ${TETO}` : ''})
              </Button>
            )}
            <Button onClick={() => void imprimir()} loading={busy} disabled={!modeloId || quantidade === null}>
              {quantidade === null ? 'Imprimir etiquetas' : `Imprimir ${quantidade} etiqueta(s)`}
            </Button>
          </div>
          <iframe
            title="Prévia da etiqueta do produto"
            srcDoc={previa}
            className="w-full h-[320px] border border-[var(--gs-border)] rounded-[var(--gs-radius)] bg-white"
          />
        </div>
      )}
    </Card>
  );
}
