/**
 * AS OPERAÇÕES DO GRUPO NO ASAAS — o que falta em cada uma (GAP-PRD-017).
 *
 * A configuração do Asaas é por operação, e a tela também: para saber o que
 * faltava nas seis, o dono trocava de empresa seis vezes. Este cartão junta as
 * operações do vínculo e diz, em cada uma, o que ainda é insumo (chave, token,
 * URL no painel do Asaas, endereço do servidor) e o que é ação nesta tela.
 * Nenhum item é código: a auditoria provou que, com a chave e o token de cada
 * operação, a cobrança funciona sem mudança.
 *
 * Só aparece para os donos do grupo; para quem o servidor recusa, some.
 */
import { useEffect, useState } from 'react';
import { Badge, Card } from '@/components/gs/ui';
import { useHasProfile } from '@/hooks/useSession';
import { asaasDoGrupoApi, type ProntidaoAsaasDoGrupo } from '@/lib/api/asaasDoGrupo';

const ROTULO_DO_TIPO: Record<string, string> = {
  credencial: 'credencial',
  configuracao_do_servidor: 'servidor',
  cadastro_no_asaas: 'painel do Asaas',
  acao_na_tela: 'nesta tela',
};

export function AsaasDoGrupoCard() {
  // Os donos do grupo (admin_geral e gestor) passam por `useHasProfile` sem
  // perfil extra — o mesmo recorte de `requireProfile(req)` da rota.
  const dono = useHasProfile();
  const [dados, setDados] = useState<ProntidaoAsaasDoGrupo | null>(null);

  useEffect(() => {
    if (!dono) return;
    let vivo = true;
    asaasDoGrupoApi
      .prontidao()
      .then((r) => {
        if (vivo) setDados(r);
      })
      .catch(() => {
        if (vivo) setDados(null);
      });
    return () => {
      vivo = false;
    };
  }, [dono]);

  if (!dono || !dados || dados.total === 0) return null;

  return (
    <Card
      title="As operações do grupo"
      subtitle={`${dados.readyForProduction} de ${dados.total} cobrando em produção. O que falta em cada uma é insumo ou ação — nenhum item é programação.`}
    >
      <ul className="list-none m-0 p-0 flex flex-col gap-3" aria-label="Prontidão do Asaas por operação">
        {dados.operations.map((o) => (
          <li
            key={o.companyId}
            data-testid={`asaas-operacao-${o.companyId}`}
            className="flex flex-col gap-1 pb-3 border-b border-[var(--gs-border)] last:border-0 last:pb-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <strong>{o.tradeName}</strong>
              {o.canChargeProduction ? (
                <Badge tone="success">cobrando em produção</Badge>
              ) : o.canChargeSandbox ? (
                <Badge tone="info">só sandbox</Badge>
              ) : (
                <Badge tone="warning">sem credencial</Badge>
              )}
            </div>
            {o.missing.length > 0 && (
              <ul className="m-0 pl-5 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                {o.missing.map((m) => (
                  <li key={m.codigo}>
                    {m.frase}{' '}
                    <span className="text-[var(--gs-muted)]">
                      ({ROTULO_DO_TIPO[m.tipo] ?? m.tipo}
                      {m.quem === 'instalacao' ? ', quem instala o servidor' : ''})
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <p className="m-0 mt-3 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
        A chave, o token e a homologação de cada operação se fazem entrando nela e voltando a esta
        tela.
      </p>
    </Card>
  );
}
