/**
 * A TENTATIVA QUE JÁ REGISTROU OUTRO LANÇAMENTO (R2-IDEM) — a pergunta da
 * casa diante do 422 CORE_IDEMPOTENCY_KEY_REUSED.
 *
 * As telas que escrevem com uma chave de idempotência só trocam a chave no
 * SUCESSO: reenviar depois de uma falha é a mesma intenção, e o servidor
 * devolve o que já aconteceu. O furo é o meio-termo — a resposta se perdeu (o
 * servidor gravou), a pessoa mudou o formulário e clicou de novo. O servidor
 * recusa a mesma chave com outro conteúdo, e a tela ficava presa: a faixa
 * repetia o texto do servidor (que fala em "chave de idempotência", coisa que
 * ninguém no balcão vê) e todo novo clique levava a mesma chave e a mesma
 * recusa.
 *
 * O desenho é o do PDV (8e46c01): dizer o que houve na língua de quem opera,
 * e oferecer "registrar como novo" (chave nova) só por ESCOLHA — sem ela, nada
 * é reenviado, porque registrar em dobro é decisão de quem vê o balcão, e não
 * da tela. O foco começa em "Voltar": Enter por reflexo não registra de novo.
 * Quem não tem "novo" a oferecer (a OS já recebida) omite `onNovo`.
 */
import type { ReactNode } from 'react';
import { DialogoBase } from './DialogoBase';
import { Button } from './ui';

export function TentativaJaRegistrada({
  titulo,
  children,
  rotuloDoVoltar = 'Voltar ao formulário',
  onVoltar,
  rotuloDoNovo,
  onNovo,
  ocupado = false,
  testId,
}: {
  titulo: string;
  children: ReactNode;
  rotuloDoVoltar?: string;
  onVoltar: () => void;
  rotuloDoNovo?: string;
  onNovo?: () => void;
  ocupado?: boolean;
  testId?: string;
}) {
  return (
    <DialogoBase
      titulo={titulo}
      onFechar={onVoltar}
      largura="sm"
      focoInicial="[data-foco-inicial]"
      testId={testId}
      rodape={
        <>
          <Button type="button" variant="ghost" data-foco-inicial onClick={onVoltar}>
            {rotuloDoVoltar}
          </Button>
          {onNovo && rotuloDoNovo && (
            <Button type="button" disabled={ocupado} onClick={onNovo}>
              {rotuloDoNovo}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[length:var(--gs-text-base)] text-[var(--gs-text)]">{children}</div>
    </DialogoBase>
  );
}
