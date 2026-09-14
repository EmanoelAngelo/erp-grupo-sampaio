/**
 * Avaliações na página do produto.
 *
 * DUAS DECISÕES QUE DEFINEM A SEÇÃO
 *
 * 1. Quem não pode avaliar não vê um formulário que vai recusar. O servidor é
 *    quem decide (exige pedido entregue), e a tela só oferece o campo depois
 *    de perguntar. Formulário que sempre dá erro ensina o cliente a ignorar a
 *    seção inteira.
 *
 * 2. Produto sem avaliação NÃO mostra "0 estrelas". Zero seria lido como nota
 *    péssima; "ainda não avaliado" é o que de fato acontece — e a diferença
 *    entre as duas coisas é uma venda.
 *
 * 3. Token guardado que o servidor recusa NÃO deixa a seção muda. Só o
 *    servidor sabe se a sessão ainda vale; quando ele responde 401 a pessoa
 *    precisa ler "entre na sua conta", e não um título seguido de nada.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiRequestError, apiRequest } from '@/lib/api/client';
import { contar } from '@/components/gs/format';
import { tokenDoPortal, limparSessaoPortal } from '@/lib/portalSession';

export interface Avaliacao {
  id: string;
  rating: number;
  comment: string | null;
  displayName: string;
  createdAt: string;
}

interface Resumo {
  average: number | null;
  count: number;
  items: Avaliacao[];
}


/**
 * Estrelas cheias e vazias.
 *
 * `role="img"` porque aria-label num <span> genérico não é exposto de forma
 * confiável: o leitor de tela caía nos caracteres crus e a nota saía como
 * "estrela preta estrela preta estrela preta…", cinco vezes por avaliação.
 * Como imagem, a nota é "4 de 5" e os glifos viram decoração.
 */
function Estrelas({ nota }: { nota: number }) {
  return (
    <span role="img" aria-label={`${nota} de 5`} className="text-[var(--gs-orange-500)]">
      <span aria-hidden="true">
        {'★'.repeat(nota)}
        <span className="text-[var(--gs-border-strong)]">{'★'.repeat(5 - nota)}</span>
      </span>
    </span>
  );
}

export function AvaliacoesProduto({ productId }: { productId: string }) {
  const [resumo, setResumo] = useState<Resumo | null>(null);
  /*
    O `resumo` sozinho fundia TRÊS estados numa frase só: enquanto a resposta
    não chegava — e quando a API falhava — a tela afirmava "ainda não foi
    avaliado". Um produto com vinte avaliações cinco estrelas mostrava a
    frase a cada abertura da página, e permanentemente com a API fora. A
    frase de vazio é uma afirmação sobre o produto; só a resposta dá o
    direito de fazê-la.
  */
  const [erroResumo, setErroResumo] = useState(false);
  const [minha, setMinha] = useState<Avaliacao | null>(null);
  const [podeAvaliar, setPodeAvaliar] = useState(false);
  const [form, setForm] = useState({ rating: 5, comment: '' });
  const [erro, setErro] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  // Token que o servidor recusou. O relógio local não decide sozinho se a
  // sessão vale: ela também morre quando o servidor a encerra.
  const [sessaoRecusada, setSessaoRecusada] = useState(false);

  const token = sessaoRecusada ? null : tokenDoPortal();

  /*
    TROCAR DE PRODUTO ZERA O QUE ERA DO ANTERIOR (rodada 57).

    A página do produto não desmonta ao navegar pela prateleira "Também em X"
    — só o parâmetro da rota muda —, então esta seção continuava montada com a
    nota, a contagem e os comentários do produto ANTERIOR na tela, sob o nome
    e o preço do novo. E como o catch desta rodada preserva o dado em vez de
    apagá-lo, uma falha na troca deixaria as avaliações do outro produto ali
    em definitivo, com a mensagem de erro em cima.
  */
  useEffect(() => {
    setResumo(null);
    setErroResumo(false);
    setMinha(null);
    setMensagem(null);
    setErro(null);
    setForm({ rating: 5, comment: '' });
  }, [productId]);

  const carregar = useCallback(async () => {
    try {
      setResumo(await apiRequest<Resumo>(`/loja/products/${productId}/avaliacoes`, { anonymous: true }));
      setErroResumo(false);
    } catch {
      setErroResumo(true);
    }

    if (!token) {
      setPodeAvaliar(false);
      return;
    }
    try {
      const r = await apiRequest<{ review: Avaliacao | null }>(
        `/loja/products/${productId}/minha-avaliacao`,
        { anonymous: true, headers: { 'x-portal-token': token } },
      );
      setMinha(r.review);
      if (r.review) setForm({ rating: r.review.rating, comment: r.review.comment ?? '' });
      // Ter avaliação prova que pode avaliar. Não ter ainda não prova nada —
      // a permissão real só se descobre ao enviar, e é o servidor quem decide.
      setPodeAvaliar(true);
    } catch (err) {
      setPodeAvaliar(false);
      // 401 é o servidor dizendo que este token não vale mais — a pessoa
      // precisa entrar de novo. Falha de rede é transitória e NÃO derruba a
      // sessão: deslogar alguém porque a API piscou seria pior que o silêncio.
      if (err instanceof ApiRequestError && err.status === 401) {
        setSessaoRecusada(true);
        try {
          limparSessaoPortal();
        } catch {
          // Sem storage, basta o estado desta aba.
        }
      }
    }
  }, [productId, token]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    setErro(null);
    setMensagem(null);
    try {
      await apiRequest(`/loja/products/${productId}/avaliacoes`, {
        method: 'POST',
        anonymous: true,
        headers: { 'x-portal-token': token ?? '' },
        body: { rating: form.rating, comment: form.comment || undefined },
      });
      setMensagem(minha ? 'Avaliação atualizada.' : 'Obrigado pela avaliação.');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível enviar.');
    }
  };

  return (
    <section className="mt-8" data-testid="avaliacoes-produto">
      <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] mb-2">
        Avaliações
      </h2>

      {/*
        O erro só fala quando NÃO há resumo: falha de ATUALIZAÇÃO — recarregar
        depois de enviar a própria nota, por exemplo — não pode apagar as
        avaliações que já estavam na tela. É a mesma regra do PIX no detalhe
        do pedido: dado na mão vence aviso de rede.
      */}
      {resumo === null && !erroResumo ? (
        <p role="status" className="m-0 mb-4 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Carregando avaliações…
        </p>
      ) : resumo === null && erroResumo ? (
        <p role="status" className="m-0 mb-4 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Não foi possível carregar as avaliações agora.
        </p>
      ) : resumo && resumo.count > 0 ? (
        <p className="m-0 mb-4 flex items-center gap-2">
          <Estrelas nota={Math.round(resumo.average ?? 0)} />
          <strong>{resumo.average?.toFixed(1)}</strong>
          <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            {contar(resumo.count, 'avaliação', 'avaliações')} de quem comprou
          </span>
        </p>
      ) : (
        // "0 estrelas" seria lido como nota péssima. Não é: é ausência de nota.
        <p className="m-0 mb-4 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Este produto ainda não foi avaliado.
        </p>
      )}

      <ul className="list-none p-0 m-0 flex flex-col gap-3 mb-6">
        {(resumo?.items ?? []).map((a) => (
          <li
            key={a.id}
            className="bg-[var(--gs-surface)] border border-[var(--gs-border)]
              rounded-[var(--gs-radius)] p-4"
          >
            <div className="flex items-center gap-2">
              <Estrelas nota={a.rating} />
              <strong className="text-[length:var(--gs-text-sm)]">{a.displayName}</strong>
              <span
                className="px-2 py-0.5 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)]
                  text-[var(--gs-success)] text-[length:var(--gs-text-xs)] font-semibold"
              >
                compra verificada
              </span>
            </div>
            {a.comment && <p className="m-0 mt-2 text-[length:var(--gs-text-sm)]">{a.comment}</p>}
          </li>
        ))}
      </ul>

      {!token ? (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
          Só quem comprou e já recebeu pode avaliar.{' '}
          <Link to="/minha-conta" className="text-[var(--gs-purple-700)] underline">
            Entre na sua conta
          </Link>{' '}
          para avaliar suas compras.
        </p>
      ) : podeAvaliar ? (
        <form
          onSubmit={(e) => void enviar(e)}
          className="bg-[var(--gs-surface)] border border-[var(--gs-border)]
            rounded-[var(--gs-radius)] p-4 flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold">Sua nota</span>
            <select
              aria-label="Sua nota"
              value={form.rating}
              onChange={(e) => setForm({ ...form, rating: Number(e.target.value) })}
              className="w-40 px-3 py-2 rounded-[var(--gs-radius)]
                border border-[var(--gs-border-strong)]"
            >
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {'★'.repeat(n)} ({n})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold">Comentário (opcional)</span>
            <textarea
              aria-label="Comentário"
              rows={3}
              maxLength={1000}
              value={form.comment}
              onChange={(e) => setForm({ ...form, comment: e.target.value })}
              className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
            />
          </label>

          {erro && (
            <p role="alert" className="m-0 text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
              {erro}
            </p>
          )}
          {mensagem && (
            <p role="status" className="m-0 text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">
              {mensagem}
            </p>
          )}

          <button
            type="submit"
            className="self-start bg-[var(--gs-purple-700)] text-white border-0
              rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer font-semibold"
          >
            {minha ? 'Atualizar avaliação' : 'Enviar avaliação'}
          </button>
          {minha && (
            <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
              Você já avaliou este produto. Enviar de novo substitui a avaliação anterior.
            </span>
          )}
        </form>
      ) : (
        // Nenhum caminho termina em silêncio: título seguido de nada faz a
        // pessoa achar que a página quebrou.
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
          Não foi possível carregar o formulário de avaliação agora. Atualize a página para tentar
          de novo.
        </p>
      )}
    </section>
  );
}
