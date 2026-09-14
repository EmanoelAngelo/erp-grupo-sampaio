/**
 * QUEM LIBERA NESTA OPERAÇÃO — o organograma que a alçada pressupõe, visível
 * na tela onde ele se decide (GAP-PRD-054).
 *
 * A liberação pontual (desconto acima da política, sangria especial, cancelar,
 * devolver, reabrir caixa) exige que alguém com alçada digite a senha ao lado
 * do operador. No banco real, só os dois donos do grupo têm essa alçada nas
 * seis operações — e nenhuma tela dizia isso. Nomear um gerente por loja é
 * decisão do dono; o caminho é esta mesma tela ("Cadastrar pessoa" com perfil
 * Gerente de loja ou de oficina). O cartão diz o que falta, com nome.
 *
 * Falhou a leitura (403, rede)? O cartão não aparece: ele é aviso, não bloqueio.
 */
import { useEffect, useState } from 'react';
import { Card } from '@/components/gs/ui';
import { alcadaApi, type QuemLibera, type QuemLiberaResposta } from '@/lib/api/alcada';

const ROTULO_DA_ACAO: Record<string, string> = {
  desconto_acima_limite: 'desconto acima da política',
  sangria_especial: 'sangria especial',
  cancelar_venda: 'cancelar venda',
  devolver_venda: 'devolver venda',
  reabrir_caixa: 'reabrir caixa',
};

const ROTULO_DO_PERFIL: Record<string, string> = {
  admin_geral: 'administrador do sistema',
  gestor: 'gestor do grupo',
  gerente_loja: 'gerente da loja',
  gerente_oficina: 'gerente da oficina',
};

function pessoas(lista: QuemLibera[]): string {
  return lista.map((p) => `${p.nome} (${ROTULO_DO_PERFIL[p.perfil] ?? p.perfil})`).join(', ');
}

export function QuemLiberaAqui() {
  const [dados, setDados] = useState<QuemLiberaResposta | null>(null);

  useEffect(() => {
    let vivo = true;
    alcadaApi
      .quemLibera()
      .then((r) => {
        if (vivo) setDados(r);
      })
      .catch(() => {
        if (vivo) setDados(null);
      });
    return () => {
      vivo = false;
    };
  }, []);

  if (!dados) return null;

  const acoes = dados.acoes.map((a) => ROTULO_DA_ACAO[a] ?? a).join(', ');

  return (
    <div className="mb-5">
      <Card title="Quem libera nesta operação">
        {dados.semAlcadaNaOperacao ? (
          <div
            role="status"
            data-testid="alcada-sem-gerente"
            className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]
              text-[length:var(--gs-text-sm)]"
          >
            <p className="m-0 font-semibold">Nenhum gerente desta operação tem alçada.</p>
            <p className="mt-1 mb-0">
              Toda liberação ({acoes}) depende de{' '}
              {dados.doGrupo.length > 0 ? pessoas(dados.doGrupo) : 'ninguém — não há autorizador'}
              , que precisa digitar a senha ao lado do operador. Para ter alguém com alçada presente
              na loja, cadastre um Gerente de loja ou Gerente de oficina aqui.
            </p>
          </div>
        ) : (
          <p data-testid="alcada-presente" className="m-0 text-[length:var(--gs-text-sm)]">
            Liberam aqui: <strong>{pessoas(dados.daOperacao)}</strong>
            {dados.doGrupo.length > 0 && <> — e, pelo grupo, {pessoas(dados.doGrupo)}</>}.
          </p>
        )}
      </Card>
    </div>
  );
}
