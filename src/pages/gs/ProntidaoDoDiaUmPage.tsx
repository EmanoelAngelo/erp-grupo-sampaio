/**
 * PRONTIDÃO DO DIA 1 — o que falta configurar, loja por loja (GAP-PRD-034).
 *
 * A auditoria achou todas as operações por configurar: entrega desligada,
 * produtos sem medida, CEP de origem ausente, sem Asaas, sem SMTP, sem
 * transportadora. Cada item tinha a sua tela — seis telas — e nenhum lugar
 * dizia, por operação, o que ainda estava por fazer. Quem abria o sistema no
 * dia 1 dependia de alguém do desenvolvimento para saber.
 *
 * Esta tela é essa lista, lida do que está GRAVADO (nada é chamado em
 * provedor): o estado de cada item, o que falta em palavras de gente, QUEM
 * resolve — a loja pela tela, ou quem administra o servidor pelo `.env` — e
 * o link da tela onde se resolve. Quem responde pelo grupo vê as operações
 * todas; o gerente, a dele.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Card, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { diaUmApi, type ItemDoDiaUm, type ProntidaoDaOperacao } from '@/lib/api/envios';

const TOM: Record<ItemDoDiaUm['estado'], 'success' | 'warning' | 'neutral'> = {
  ok: 'success',
  pendente: 'warning',
  escolha: 'neutral',
};

const ROTULO: Record<ItemDoDiaUm['estado'], string> = {
  ok: 'Pronto',
  pendente: 'Falta',
  escolha: 'Escolha da loja',
};

function Operacao({ op }: { op: ProntidaoDaOperacao }) {
  return (
    <Card
      title={op.companyName}
      subtitle={op.pronta ? 'Nada pendente.' : `${op.pendentes} pendência(s) para operar completo.`}
      className="mb-5"
    >
      <ul className="list-none p-0 m-0 flex flex-col gap-3" data-testid={`dia-um-${op.companyId}`}>
        {op.itens.map((i) => (
          <li key={i.chave} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
            <span className="shrink-0">
              <Badge tone={TOM[i.estado]}>{ROTULO[i.estado]}</Badge>
            </span>
            <span className="flex-1">
              <strong className="block">{i.titulo}</strong>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">{i.detalhe}</span>
              {i.estado !== 'ok' && (
                <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  {i.quem === 'servidor'
                    ? 'Resolve: quem administra o servidor (arquivo .env da API).'
                    : 'Resolve: a loja, pela tela.'}
                  {i.onde && (
                    <>
                      {' '}
                      <Link to={i.onde} className="text-[var(--gs-purple-700)] font-semibold">
                        Abrir a tela
                      </Link>
                    </>
                  )}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function ProntidaoDoDiaUmPage() {
  const [operacoes, setOperacoes] = useState<ProntidaoDaOperacao[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const r = await diaUmApi.ler();
      if (!Array.isArray(r?.operacoes)) throw new Error('resposta sem "operacoes"');
      setOperacoes(r.operacoes);
    } catch (err) {
      setOperacoes(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível ler a prontidão das operações.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['E-commerce', 'Prontidão do dia 1']}
        title="Prontidão do dia 1"
        subtitle="O que falta configurar em cada operação para vender online completo — e onde se resolve."
      />
      {erro && (
        <div role="alert" className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]">
          {erro}
        </div>
      )}
      {!operacoes && !erro && (
        <p role="status" className="text-[var(--gs-muted)]">
          Lendo a configuração das operações…
        </p>
      )}
      {operacoes?.map((op) => <Operacao key={op.companyId} op={op} />)}
    </AppShell>
  );
}
