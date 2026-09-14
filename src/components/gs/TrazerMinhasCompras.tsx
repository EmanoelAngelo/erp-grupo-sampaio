/**
 * "Trazer minhas compras pelo CPF" — o controle que faltava (GAP-PRD-028/043).
 *
 * A conta prometia "vincular suas compras pelo CPF" e não tinha campo nenhum:
 * `POST /portal/vincular` existia e nenhuma tela o chamava. Os PEDIDOS da loja
 * online já chegam sozinhos — os feitos logado são da conta, e os feitos como
 * visitante com o e-mail confirmado aparecem por ele. O que o documento traz
 * é o CADASTRO da loja que carrega esse e-mail e esse documento: é o que liga
 * as compras de balcão, os equipamentos e as ordens de serviço.
 *
 * Só com o e-mail confirmado: documento digitado sem a caixa provada não traz
 * nada de ninguém (o servidor recusa com 403, e a tela diz antes).
 */
import { useState } from 'react';
import { ApiRequestError } from '@/lib/api/client';
import { comTokenPortal } from '@/lib/portalSession';

export function TrazerMinhasCompras({
  token,
  email,
  verificado,
  onTrouxe,
}: {
  token: string;
  email: string;
  verificado: boolean;
  /** Algo novo foi ligado: quem usa recarrega pedidos e dados. */
  onTrouxe: () => void;
}) {
  const [documento, setDocumento] = useState('');
  const [resposta, setResposta] = useState<{ tom: 'ok' | 'erro'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const trazer = async (e: React.FormEvent) => {
    e.preventDefault();
    setOcupado(true);
    setResposta(null);
    try {
      const r = await comTokenPortal<{ linked: number; novos?: number; message: string }>(
        '/loja/portal/vincular',
        token,
        { method: 'POST', body: { document: documento } },
      );
      setResposta({ tom: 'ok', texto: r.message });
      if ((r.novos ?? 0) > 0) {
        setDocumento('');
        onTrouxe();
      }
    } catch (err) {
      setResposta({
        tom: 'erro',
        texto: err instanceof ApiRequestError ? err.message : 'Não deu para buscar agora.',
      });
    } finally {
      setOcupado(false);
    }
  };

  return (
    <section
      aria-label="Trazer minhas compras"
      className="mt-8 bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-4"
    >
      <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] m-0">
        Trazer minhas compras pelo CPF
      </h2>
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-1 mb-3">
        Os pedidos da loja online feitos com <strong>{email}</strong> já aparecem acima. Informe o
        CPF ou CNPJ que você usou nas lojas para trazer também o seu cadastro — compras de balcão,
        equipamentos e serviços da oficina.
      </p>
      {!verificado && (
        <p role="status" className="text-[length:var(--gs-text-sm)] text-[var(--gs-warning)] mt-0">
          Confirme seu e-mail primeiro: sem ele, nenhum documento traz compra nenhuma.
        </p>
      )}
      <form onSubmit={(e) => void trazer(e)} className="flex flex-wrap items-center gap-2">
        <input
          required
          inputMode="numeric"
          placeholder="CPF ou CNPJ"
          aria-label="CPF ou CNPJ das compras"
          value={documento}
          onChange={(e) => setDocumento(e.target.value)}
          disabled={!verificado}
          className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
        />
        <button
          type="submit"
          disabled={!verificado || ocupado || !documento.trim()}
          className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)]
            px-4 py-2 cursor-pointer font-semibold disabled:opacity-50"
        >
          {ocupado ? 'Buscando…' : 'Trazer minhas compras'}
        </button>
      </form>
      {resposta && (
        <p
          role={resposta.tom === 'erro' ? 'alert' : 'status'}
          className={`text-[length:var(--gs-text-sm)] mt-2 mb-0 ${
            resposta.tom === 'erro' ? 'text-[var(--gs-danger)]' : ''
          }`}
        >
          {resposta.texto}
        </p>
      )}
    </section>
  );
}
