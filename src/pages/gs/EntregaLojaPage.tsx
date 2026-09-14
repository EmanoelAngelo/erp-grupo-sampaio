/**
 * Como esta operação entrega pelo site.
 *
 * POR QUE ESTA TELA EXISTE
 *
 * Antes dela, o checkout da loja não perguntava nada: todo pedido online
 * nascia como ENTREGA com frete R$ 0,00, e a operação pagava o envio de cada
 * venda sem que o valor aparecesse em lugar nenhum. Ligar entrega passou a
 * ser uma decisão explícita, com preço declarado por quem responde por ele.
 *
 * AS TRÊS ORIGENS DE PREÇO, EM ORDEM
 *
 *   1. Transportadora conectada — cotação real, prazo dela. Quando existir
 *      credencial, tem preferência automática sobre o que se declara aqui.
 *   2. Tabela da loja — o valor desta tela. É preço de gente, e por isso pode
 *      ser cobrado hoje, sem credencial nenhuma.
 *   3. Nada — a loja oferece só retirada, e diz isso ao cliente.
 *
 * O que NÃO é uma origem: a cotação simulada que o sistema produz sem
 * credencial. Ela serve para conferir a tela; cobrar por ela seria vender
 * transporte a preço de chute e descobrir a diferença depois do despacho.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, apiRequest } from '@/lib/api/client';
import { AppShell } from '@/components/gs/AppShell';
import { formatCents, parseReaisToCents } from '@/components/gs/format';

interface Config {
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  flatRateCents: number | null;
  freeAboveCents: number | null;
  estimatedDays: number | null;
}

/** Centavos viram o texto que o gestor edita; vazio é "não configurado". */
function paraTexto(cents: number | null): string {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2).replace('.', ',');
}

export default function EntregaLojaPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [frete, setFrete] = useState('');
  const [gratisAcima, setGratisAcima] = useState('');
  const [prazo, setPrazo] = useState('');
  const [entrega, setEntrega] = useState(false);
  const [retirada, setRetirada] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const c = await apiRequest<Config>('/core/shipping-settings');
      setConfig(c);
      setEntrega(c.deliveryEnabled);
      setRetirada(c.pickupEnabled);
      setFrete(paraTexto(c.flatRateCents));
      setGratisAcima(paraTexto(c.freeAboveCents));
      setPrazo(c.estimatedDays === null ? '' : String(c.estimatedDays));
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível carregar.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const salvar = async (e: React.FormEvent) => {
    e.preventDefault();
    setErro(null);
    setOk(null);
    // Prazo é contagem de dias úteis: inteiro, zero ou mais (GAP-PRD-195).
    // "-3" e "2,5" nem saem daqui — e texto virava `NaN`, que o JSON manda
    // como null e apagava o prazo em silêncio. O servidor confere de novo.
    const prazoLimpo = prazo.trim();
    if (prazoLimpo !== '' && !/^\d+$/.test(prazoLimpo)) {
      setErro('Prazo em dias úteis: informe um número inteiro, zero ou mais — ou deixe em branco.');
      return;
    }
    setSalvando(true);
    try {
      const c = await apiRequest<Config>('/core/shipping-settings', {
        method: 'PUT',
        body: {
          pickupEnabled: retirada,
          deliveryEnabled: entrega,
          // Campo vazio é "não configurado", que é diferente de zero — zero em
          // "grátis acima de" significaria grátis SEMPRE. Quem garante isso é
          // `parseReaisToCents`, que devolve null para texto vazio; repetir a
          // checagem aqui só criaria duas regras para divergirem depois.
          flatRateCents: parseReaisToCents(frete),
          freeAboveCents: parseReaisToCents(gratisAcima),
          estimatedDays: prazoLimpo === '' ? null : Number(prazoLimpo),
        },
      });
      setConfig(c);
      setOk('Configuração de entrega salva.');
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível salvar.');
    } finally {
      setSalvando(false);
    }
  };

  if (!config && !erro) {
    return (
      <AppShell>
        <p className="p-6">Carregando…</p>
      </AppShell>
    );
  }

  return (
    <AppShell>
    <div className="p-6 max-w-2xl">
      <h1 className="text-[length:var(--gs-text-2xl)] font-bold text-[var(--gs-purple-900)] mt-0 mb-1">
        Entrega pelo site
      </h1>
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-6">
        Enquanto a entrega estiver desligada, a loja aceita pedidos apenas para retirada — e
        avisa o cliente disso na hora de fechar.
      </p>

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] mb-4">
          {erro}
        </p>
      )}
      {ok && (
        <p role="status" className="text-[var(--gs-success)] mb-4">
          {ok}
        </p>
      )}

      <form onSubmit={(e) => void salvar(e)} className="flex flex-col gap-5">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={retirada}
            onChange={(e) => setRetirada(e.target.checked)}
          />
          <span>
            <strong>Aceitar retirada na loja</strong>
            <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Sem custo de envio. Desligar isto e a entrega ao mesmo tempo fecha a loja online.
            </span>
          </span>
        </label>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={entrega}
            onChange={(e) => setEntrega(e.target.checked)}
          />
          <span>
            <strong>Entregar pelo site</strong>
            <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Exige um valor de frete. Sem ele, a loja voltaria a despachar de graça.
            </span>
          </span>
        </label>

        <fieldset
          disabled={!entrega}
          className="border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-4
            flex flex-col gap-4 disabled:opacity-50"
        >
          <legend className="px-1 text-[length:var(--gs-text-sm)] font-semibold">Tabela da loja</legend>

          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold">Frete (R$)</span>
            <input
              value={frete}
              onChange={(e) => setFrete(e.target.value)}
              inputMode="decimal"
              placeholder="0,00"
              aria-label="Frete"
              className="w-40 px-3 py-2 rounded-[var(--gs-radius)]
                border border-[var(--gs-border-strong)]"
            />
            <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
              Cobrado por pedido, não por item. Quando houver transportadora conectada, a
              cotação real dela substitui este valor.
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold">
              Frete grátis acima de (R$)
            </span>
            <input
              value={gratisAcima}
              onChange={(e) => setGratisAcima(e.target.value)}
              inputMode="decimal"
              placeholder="deixe vazio para não ter"
              aria-label="Frete grátis acima de"
              className="w-56 px-3 py-2 rounded-[var(--gs-radius)]
                border border-[var(--gs-border-strong)]"
            />
            <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
              Vazio é "não há frete grátis". Zero seria "grátis sempre" — decisão diferente.
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold">
              Prazo em dias úteis
            </span>
            <input
              value={prazo}
              onChange={(e) => setPrazo(e.target.value)}
              inputMode="numeric"
              placeholder="deixe vazio se não souber"
              aria-label="Prazo em dias úteis"
              className="w-56 px-3 py-2 rounded-[var(--gs-radius)]
                border border-[var(--gs-border-strong)]"
            />
            <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
              Número inteiro, contado a partir da expedição. Vazio faz a loja dizer que o prazo
              é confirmado no envio — melhor do que uma data que ninguém prometeu.
            </span>
          </label>
        </fieldset>

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={salvando}
            className="bg-[var(--gs-purple-700)] hover:bg-[var(--gs-purple-800)] text-white border-0
              rounded-[var(--gs-radius)] px-5 py-2 font-semibold cursor-pointer disabled:opacity-50"
          >
            {salvando ? 'Salvando…' : 'Salvar'}
          </button>

          {config && (
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Hoje a loja{' '}
              {config.deliveryEnabled
                ? `entrega por ${formatCents(config.flatRateCents ?? 0)}`
                : 'não entrega pelo site'}
              .
            </span>
          )}
        </div>
      </form>
    </div>
    </AppShell>
  );
}
