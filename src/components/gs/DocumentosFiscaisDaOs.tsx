/**
 * OS DOCUMENTOS FISCAIS DA OS PAGA — GAP-PRD-024.
 *
 * A OS paga não tinha ação fiscal nenhuma: a venda dela era uma linha só, sem
 * produto, e a NFC-e a recusava; a mão de obra não tinha documento. Agora a
 * venda sai itemizada, e este cartão mostra os DOIS caminhos, cada um com o
 * documento dele:
 *
 *   - PEÇAS → NFC-e, pelas MESMAS rotas do PDV (prontidão da venda, emitir,
 *     situação). A nota leva só as peças, com o pagamento rateado — o
 *     servidor separa; a tela não recalcula nada;
 *   - MÃO DE OBRA → NFS-e: emitir pela Sefin Nacional, ou registrar a emitida
 *     no portal, conforme a decisão do dono em Fiscal › Configuração.
 *
 * Quando não dá, a tela diz o motivo que o servidor deu — o botão só aparece
 * quando a emissão pode andar.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Field, Input } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type FiscalSaleStatus, type SaleEmissionReadiness } from '@/lib/api/core';
import {
  nfseApi,
  ROTULO_DA_SITUACAO_DA_NFSE,
  type ProntidaoDaNfseDaVenda,
  type SituacaoDaNfse,
} from '@/lib/api/nfse';

const TOM_DA_NFSE: Record<SituacaoDaNfse, 'neutral' | 'warning' | 'success'> = {
  ENVIANDO: 'warning',
  AUTORIZADA: 'success',
  REJEITADA: 'warning',
  SEM_RESPOSTA: 'warning',
  REGISTRADA: 'success',
  CANCELADA: 'neutral',
};

function mensagemDe(err: unknown, padrao: string): string {
  return err instanceof ApiRequestError ? err.message : padrao;
}

function agoraLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function Motivos({ itens }: { itens: string[] }) {
  if (itens.length === 0) return null;
  return (
    <ul className="list-disc pl-5 mt-1 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
      {itens.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}

export function DocumentosFiscaisDaOs({
  saleId,
  podeEmitir,
}: {
  saleId: string;
  /** Caixa da oficina e gerência: quem cobrou emite a nota. */
  podeEmitir: boolean;
}) {
  const [nfce, setNfce] = useState<FiscalSaleStatus | null>(null);
  const [prontidaoNfce, setProntidaoNfce] = useState<SaleEmissionReadiness | null>(null);
  const [nfse, setNfse] = useState<ProntidaoDaNfseDaVenda | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [numero, setNumero] = useState('');
  const [codigo, setCodigo] = useState('');
  const [chave, setChave] = useState('');
  const [emitidaEm, setEmitidaEm] = useState(agoraLocal());

  const carregar = useCallback(async () => {
    // Cada metade responde por si: a queda de uma não esconde a outra.
    const [s, r, n] = await Promise.allSettled([
      coreApi.getFiscalStatusForSale(saleId),
      coreApi.getEmissionReadinessForSale(saleId),
      nfseApi.daVenda(saleId),
    ]);
    setNfce(s.status === 'fulfilled' ? s.value : null);
    setProntidaoNfce(r.status === 'fulfilled' ? r.value : null);
    setNfse(n.status === 'fulfilled' ? n.value : null);
  }, [saleId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function agir(acao: () => Promise<unknown>, falha: string) {
    setOcupado(true);
    setErro(null);
    try {
      await acao();
      await carregar();
    } catch (err) {
      setErro(mensagemDe(err, falha));
    } finally {
      setOcupado(false);
    }
  }

  const doc = nfse?.document ?? null;
  const reemitir = Boolean(doc && (doc.status === 'REJEITADA' || doc.status === 'SEM_RESPOSTA'));
  const ambiente = nfse?.environment === 'production' ? 'produção' : 'homologação — sem valor fiscal';

  return (
    <Card
      title="Documentos fiscais da OS"
      subtitle="A peça é mercadoria e sai na NFC-e; a mão de obra é serviço e sai na NFS-e. Cada uma com o seu documento."
      className="mb-5"
    >
      {erro && (
        <p
          role="alert"
          className="px-3 py-2 mb-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
        >
          {erro}
        </p>
      )}

      <section aria-label="Peças — NFC-e" className="mb-4">
        <p className="m-0 font-semibold">Peças — NFC-e</p>
        {nfce ? (
          <p className="m-0 mt-1 text-[length:var(--gs-text-sm)]">
            <Badge tone={nfce.terminal ? 'success' : 'warning'}>{nfce.statusLabel}</Badge>
            {nfce.isTest && <span className="ml-2">Ambiente de teste — sem valor fiscal.</span>}
          </p>
        ) : prontidaoNfce?.canEmit ? (
          podeEmitir ? (
            <Button
              size="sm"
              className="mt-2"
              loading={ocupado}
              onClick={() => void agir(() => coreApi.emitNfceForSale(saleId), 'Falha ao emitir a NFC-e.')}
            >
              Emitir NFC-e das peças
            </Button>
          ) : (
            <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Pronta para emitir — quem emite é o caixa da oficina.
            </p>
          )
        ) : (
          <Motivos itens={prontidaoNfce?.reasons ?? ['Não foi possível consultar a nota das peças.']} />
        )}
      </section>

      <section aria-label="Mão de obra — NFS-e">
        <p className="m-0 font-semibold">
          Mão de obra — NFS-e{nfse && nfse.serviceCents > 0 ? ` (${formatCents(nfse.serviceCents)})` : ''}
        </p>

        {doc && (
          <div className="mt-1 text-[length:var(--gs-text-sm)]">
            <Badge tone={TOM_DA_NFSE[doc.status]}>{ROTULO_DA_SITUACAO_DA_NFSE[doc.status]}</Badge>
            {doc.nfseNumber && <span className="ml-2">NFS-e nº {doc.nfseNumber}</span>}
            {doc.accessKey && <span className="ml-2 break-all">Chave {doc.accessKey}</span>}
            {doc.simulated && <p className="m-0 mt-1 font-semibold">SIMULADOR — SEM VALOR FISCAL</p>}
            {doc.reason && <p className="m-0 mt-1 text-[var(--gs-muted)]">{doc.reason}</p>}
          </div>
        )}

        {nfse?.action === 'EMITIR' && (!doc || reemitir) && (
          nfse.canEmit ? (
            podeEmitir && (
              <Button
                size="sm"
                className="mt-2"
                loading={ocupado}
                onClick={() => void agir(() => nfseApi.emitir(saleId), 'Falha ao emitir a NFS-e.')}
              >
                {reemitir ? 'Tentar de novo (mesmo número de DPS)' : `Emitir NFS-e (${ambiente})`}
              </Button>
            )
          ) : (
            <Motivos itens={nfse.reasons} />
          )
        )}

        {nfse?.action === 'REGISTRAR' && podeEmitir && (
          <form
            className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2"
            onSubmit={(e) => {
              e.preventDefault();
              void agir(
                () =>
                  nfseApi.registrar(saleId, {
                    numero: numero.trim(),
                    codigoVerificacao: codigo.trim() || null,
                    chaveAcesso: chave.trim() || null,
                    emitidaEm: new Date(emitidaEm).toISOString(),
                  }),
                'Falha ao registrar a NFS-e.',
              );
            }}
          >
            <p className="m-0 sm:col-span-2 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Emita a NFS-e de {formatCents(nfse.serviceCents)} no portal e registre aqui o número dela.
            </p>
            <Field label="Número da NFS-e">
              {(p) => <Input {...p} value={numero} onChange={(e) => setNumero(e.target.value)} required />}
            </Field>
            <Field label="Código de verificação">
              {(p) => <Input {...p} value={codigo} onChange={(e) => setCodigo(e.target.value)} />}
            </Field>
            <Field label="Chave de acesso (se houver)" hint="A NFS-e nacional tem 50 dígitos">
              {(p) => <Input {...p} value={chave} onChange={(e) => setChave(e.target.value)} />}
            </Field>
            <Field label="Emitida em">
              {(p) => (
                <Input
                  {...p}
                  type="datetime-local"
                  value={emitidaEm}
                  onChange={(e) => setEmitidaEm(e.target.value)}
                  required
                />
              )}
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit" size="sm" loading={ocupado}>
                Registrar NFS-e
              </Button>
            </div>
          </form>
        )}

        {nfse?.action === 'NENHUMA' && !doc && <Motivos itens={nfse.reasons ?? []} />}
        {!nfse && <Motivos itens={['Não foi possível consultar a NFS-e desta venda.']} />}
      </section>
    </Card>
  );
}
