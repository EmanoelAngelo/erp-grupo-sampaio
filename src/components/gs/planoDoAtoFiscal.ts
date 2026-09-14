/**
 * O plano de um ato com a SEFAZ, lido pela tela antes do botão (GAP-PRD-005).
 *
 * A lógica mora aqui, fora do componente, para os três diálogos — cancelar,
 * corrigir e inutilizar — perguntarem a mesma coisa do mesmo jeito.
 */
import { useEffect, useState } from 'react';
import { ApiRequestError } from '@/lib/api/client';
import { fiscalAtosApi, type PlanoDoAtoFiscal } from '@/lib/api/fiscalAtos';

export interface EstadoDoPlano {
  plano: PlanoDoAtoFiscal | null;
  /** Falha ao perguntar — o ato ainda pode ser tentado: quem decide é o servidor. */
  erro: string | null;
  carregando: boolean;
}

/** Pergunta ao servidor como o ato vai sair. `documentId` nulo = inutilização. */
export function usePlanoDoAtoFiscal(documentId: string | null): EstadoDoPlano {
  const [estado, setEstado] = useState<EstadoDoPlano>({ plano: null, erro: null, carregando: true });

  useEffect(() => {
    let vivo = true;
    fiscalAtosApi
      .plano(documentId)
      .then((plano) => {
        if (vivo) setEstado({ plano, erro: null, carregando: false });
      })
      .catch((err: unknown) => {
        if (!vivo) return;
        setEstado({
          plano: null,
          erro:
            err instanceof ApiRequestError
              ? err.message
              : 'Não foi possível conferir como este ato vai à SEFAZ.',
          carregando: false,
        });
      });
    return () => {
      vivo = false;
    };
  }, [documentId]);

  return estado;
}

/**
 * O botão pode ser apertado?
 *
 * Não quando o servidor já disse que o ato está bloqueado, nem quando a senha
 * é obrigatória e ninguém a digitou. Se a pergunta falhou, o botão fica
 * disponível: a recusa, se houver, vem do servidor com o motivo.
 */
export function podeEnviarAtoFiscal(estado: EstadoDoPlano, senha: string): boolean {
  if (estado.carregando) return false;
  if (!estado.plano) return true;
  if (estado.plano.caminho === 'BLOQUEADO') return false;
  if (estado.plano.senha === 'OBRIGATORIA' && !senha.trim()) return false;
  return true;
}
