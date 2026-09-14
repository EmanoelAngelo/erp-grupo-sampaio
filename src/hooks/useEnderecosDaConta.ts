/**
 * Os endereços da conta, lidos UMA vez por token e relidos quando alguém
 * cadastra ou edita (GAP-PRD-115). O checkout usa a mesma lista para a
 * entrega e para a nota fiscal: duas leituras separadas divergiriam no
 * instante em que a pessoa cadastra um endereço novo numa delas.
 */
import { useCallback, useEffect, useState } from 'react';
import { enderecosApi, type EnderecoDaConta } from '@/lib/api/enderecos';

export function useEnderecosDaConta(token: string | null | undefined): {
  /** `null` = ainda carregando (ou sem conta). */
  enderecos: EnderecoDaConta[] | null;
  erro: string | null;
  recarregar: () => Promise<EnderecoDaConta[]>;
} {
  const [enderecos, setEnderecos] = useState<EnderecoDaConta[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const recarregar = useCallback(async () => {
    if (!token) {
      setEnderecos(null);
      return [];
    }
    try {
      const lista = await enderecosApi.listar(token);
      setEnderecos(lista);
      setErro(null);
      return lista;
    } catch (err) {
      setEnderecos([]);
      setErro(err instanceof Error ? err.message : 'Falha ao carregar seus endereços.');
      return [];
    }
  }, [token]);

  useEffect(() => {
    void recarregar();
  }, [recarregar]);

  return { enderecos, erro, recarregar };
}
