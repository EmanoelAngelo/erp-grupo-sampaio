/**
 * A tabela oficial de municípios do IBGE está carregada no servidor?
 * (IBGE-MUNICIPIOS)
 *
 * 'carregando' e 'vazia' mostram o campo digitado de sempre — a tela nunca
 * fica sem jeito de informar o código. Só 'carregada' troca o campo pelo
 * seletor de cidade. Servidor fora do ar ou antigo (sem a rota) = 'vazia'.
 */
import { useEffect, useState } from 'react';
import { municipiosApi } from '@/lib/api/municipios';

export type SituacaoDaTabela = 'carregando' | 'carregada' | 'vazia';

export function useTabelaDeMunicipios(): SituacaoDaTabela {
  const [situacao, setSituacao] = useState<SituacaoDaTabela>('carregando');
  useEffect(() => {
    const controle = new AbortController();
    municipiosApi
      .situacao(controle.signal)
      .then((r) => {
        if (!controle.signal.aborted) setSituacao(r?.carregada === true ? 'carregada' : 'vazia');
      })
      .catch(() => {
        if (!controle.signal.aborted) setSituacao('vazia');
      });
    return () => controle.abort();
  }, []);
  return situacao;
}
