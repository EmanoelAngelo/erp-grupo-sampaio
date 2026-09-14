/**
 * As bancadas onde quem está logado pode abrir OS e cadastrar equipamento
 * (GAP-PRD-099) — a lista do servidor, `GET /core/workshop/entrada`.
 *
 * Nula enquanto carrega; vazia se a consulta falhar — a abertura continua, e o
 * servidor diz o que falta. Só é pedida quando `ativo` (o formulário aberto).
 */
import { useEffect, useState } from 'react';
import { oficinaEntradaApi, type BancadaDeEntrada } from '@/lib/api/oficinaEntrada';

export function useBancadasDeEntrada(ativo: boolean): BancadaDeEntrada[] | null {
  const [bancadas, setBancadas] = useState<BancadaDeEntrada[] | null>(null);
  useEffect(() => {
    if (!ativo) return undefined;
    let vivo = true;
    oficinaEntradaApi
      .bancadas()
      .then((b) => {
        if (vivo) setBancadas(b);
      })
      .catch(() => {
        if (vivo) setBancadas([]);
      });
    return () => {
      vivo = false;
    };
  }, [ativo]);
  return bancadas;
}
