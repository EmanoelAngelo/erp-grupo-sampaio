/**
 * QUEM ASSINA O E-MAIL DESTA EMPRESA (GAP-PRD-198) — a escolha do dono.
 *
 * Tudo saía com o remetente único do servidor: o cliente da Gringa recebia
 * de "grupo@…" e a resposta dele caía numa caixa só. Aqui o gerente escolhe,
 * para a empresa em que está logado:
 *
 *   - Remetente do grupo (o padrão): exatamente como sempre foi;
 *   - Remetente desta empresa: o nome no "De:", o "Responder para" da loja, a
 *     assinatura no fim da mensagem e, se o provedor permitir, o endereço
 *     próprio.
 *
 * A prévia vem do SERVIDOR ("é assim que o cliente vê"), com o EMAIL_FROM de
 * agora — a tela não monta cabeçalho por conta própria.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, apiRequest, exigirCampos } from '@/lib/api/client';

interface Identidade {
  modo: 'grupo' | 'empresa';
  nomeRemetente: string | null;
  enderecoRemetente: string | null;
  responderPara: string | null;
  assinatura: string | null;
  updatedAt: string | null;
}

interface Previa {
  de: string | null;
  responderPara: string | null;
  assinatura: string;
  aviso: string | null;
}

interface Resposta {
  identidade: Identidade;
  previa: Previa;
}

const VAZIO = { nomeRemetente: '', enderecoRemetente: '', responderPara: '', assinatura: '' };

export function RemetenteDaEmpresa() {
  const [dados, setDados] = useState<Resposta | null>(null);
  const [modo, setModo] = useState<'grupo' | 'empresa'>('grupo');
  const [form, setForm] = useState(VAZIO);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const aplicar = useCallback((r: Resposta) => {
    setDados(r);
    setModo(r.identidade.modo);
    setForm({
      nomeRemetente: r.identidade.nomeRemetente ?? '',
      enderecoRemetente: r.identidade.enderecoRemetente ?? '',
      responderPara: r.identidade.responderPara ?? '',
      assinatura: r.identidade.assinatura ?? '',
    });
  }, []);

  useEffect(() => {
    apiRequest<Resposta>('/core/emails/identidade')
      .then((r) => exigirCampos(r, 'identidade', 'previa'))
      .then(aplicar)
      .catch((err: unknown) => {
        setErro(
          err instanceof ApiRequestError ? err.message : 'Não foi possível carregar o remetente.',
        );
      });
  }, [aplicar]);

  const salvar = async () => {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      const r = await apiRequest<Resposta>('/core/emails/identidade', {
        method: 'PUT',
        body: { modo, ...form },
      }).then((x) => exigirCampos(x, 'identidade', 'previa'));
      aplicar(r);
      setAviso('Remetente salvo. As próximas mensagens desta empresa já saem assim.');
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível salvar o remetente.');
    } finally {
      setSalvando(false);
    }
  };

  const campo = (
    chave: keyof typeof VAZIO,
    rotulo: string,
    ajuda: string,
    placeholder: string,
  ) => (
    <label className="flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
      <span className="font-semibold">{rotulo}</span>
      <input
        aria-label={rotulo}
        value={form[chave]}
        placeholder={placeholder}
        disabled={modo !== 'empresa'}
        onChange={(e) => setForm({ ...form, [chave]: e.target.value })}
        className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
          bg-[var(--gs-surface)] disabled:opacity-60"
      />
      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">{ajuda}</span>
    </label>
  );

  return (
    <section
      aria-label="Remetente desta empresa"
      className="bg-[var(--gs-surface)] border border-[var(--gs-border)]
        rounded-[var(--gs-radius-lg)] p-5 mb-6"
    >
      <strong className="text-[length:var(--gs-text-lg)]">Quem assina os e-mails desta empresa</strong>
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-1 mb-3">
        É uma escolha do dono. O padrão é o remetente do grupo; com o remetente desta empresa, o
        cliente vê o nome da loja no &quot;De:&quot; e a resposta dele chega na caixa da loja.
      </p>

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] m-0 mb-3">
          {erro}
        </p>
      )}
      {aviso && (
        <p role="status" className="text-[var(--gs-info)] m-0 mb-3">
          {aviso}
        </p>
      )}

      <fieldset className="border-0 p-0 m-0 mb-3 flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
        <legend className="sr-only">Remetente</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="modo-remetente"
            checked={modo === 'grupo'}
            onChange={() => setModo('grupo')}
          />
          Remetente do grupo (padrão) — como sempre foi
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="modo-remetente"
            checked={modo === 'empresa'}
            onChange={() => setModo('empresa')}
          />
          Remetente desta empresa
        </label>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2 mb-3">
        {campo('nomeRemetente', 'Nome no "De:"', 'Obrigatório no remetente desta empresa.', 'Gringa')}
        {campo(
          'responderPara',
          'Responder para',
          'A resposta do cliente vai para este endereço.',
          'contato@loja.com.br',
        )}
        {campo(
          'assinatura',
          'Assinatura',
          'A última linha das mensagens de pedido e oficina.',
          'Gringa — atendimento de seg. a sáb.',
        )}
        {campo(
          'enderecoRemetente',
          'Endereço próprio (opcional)',
          'Só se o provedor de e-mail permitir enviar por ele. Vazio: usa o do servidor.',
          'loja@loja.com.br',
        )}
      </div>

      {dados && (
        <div className="text-[length:var(--gs-text-sm)] border-t border-[var(--gs-border)] pt-3">
          <span className="text-[var(--gs-muted)]">Como o cliente vê hoje:</span>
          <ul className="mt-1 mb-0 pl-5">
            <li>
              De: <span className="font-mono">{dados.previa.de ?? '(remetente do servidor não configurado)'}</span>
            </li>
            <li>
              Responder para:{' '}
              <span className="font-mono">{dados.previa.responderPara ?? 'o próprio remetente'}</span>
            </li>
            <li>Assinatura: {dados.previa.assinatura}</li>
          </ul>
          {dados.previa.aviso && (
            <p className="mt-2 mb-0 text-[var(--gs-warning)]">{dados.previa.aviso}</p>
          )}
        </div>
      )}

      <button
        type="button"
        disabled={salvando}
        onClick={() => void salvar()}
        className="mt-4 bg-[var(--gs-purple-700)] hover:bg-[var(--gs-purple-800)] text-white
          border-0 rounded-[var(--gs-radius)] px-4 py-2 font-semibold cursor-pointer disabled:opacity-60"
      >
        {salvando ? 'Salvando…' : 'Salvar remetente'}
      </button>
    </section>
  );
}
