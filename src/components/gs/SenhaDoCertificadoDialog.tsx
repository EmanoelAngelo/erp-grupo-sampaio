/**
 * A SENHA DO A1 NUM DIÁLOGO DA CASA — a consulta e a manifestação DF-e
 * (GAP-PRD-168).
 *
 * A Entrada de notas não tinha onde digitar a senha do certificado: mandava
 * `{}` e `{tipo}`, e o servidor só abria o A1 com a senha no corpo. Agora a
 * consulta e a manifestação seguem a política dos atos — com o COFRE (padrão)
 * nada é pedido; com "cada ato pede a senha", é este diálogo que pede.
 *
 *  - é o `DialogoBase`: o foco entra no campo da senha, gira dentro dele e
 *    volta a quem abriu; Esc fecha. Nada de `window.prompt`, que mostraria a
 *    senha em claro e bloquearia a aba;
 *  - a senha vive só no estado deste diálogo: fechou, sumiu. O próximo ato
 *    pede de novo — é o que o dono escolheu ao exigir a senha a cada ato;
 *  - quando o SERVIDOR pediu a senha que o plano não previa (a política mudou
 *    enquanto a tela estava aberta), o motivo dele aparece no lugar do plano.
 */
import { useState } from 'react';
import { Button } from '@/components/gs/ui';
import { DialogoBase } from '@/components/gs/DialogoBase';
import { CaminhoDoAtoFiscal, CampoSenhaDoA1 } from '@/components/gs/CaminhoDoAtoFiscal';
import type { PlanoDoAtoFiscal } from '@/lib/api/fiscalAtos';

export function SenhaDoCertificadoDialog({
  plano,
  descricao,
  aviso,
  onEnviar,
  onFechar,
}: {
  /** O caminho que o servidor anunciou — para dizer para onde o ato vai. */
  plano: PlanoDoAtoFiscal | null;
  /** O ato em linguagem de gerente: "Buscar as notas…", "Manifestar ciência…". */
  descricao: string;
  /** A recusa do servidor que pediu a senha, quando foi ele quem pediu. */
  aviso: string | null;
  onEnviar: (senha: string) => void;
  onFechar: () => void;
}) {
  const [senha, setSenha] = useState('');
  const pronta = senha.trim().length > 0;

  return (
    <DialogoBase
      titulo="Este ato pede a senha do certificado"
      subtitulo={descricao}
      onFechar={onFechar}
      largura="sm"
      focoInicial='input[type="password"]'
      testId="senha-do-certificado"
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (pronta) onEnviar(senha);
        }}
      >
        {aviso ? (
          <p
            role="alert"
            className="m-0 px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-warning)]
              bg-[var(--gs-warning-bg)] text-[var(--gs-warning)] text-[length:var(--gs-text-sm)]"
          >
            {aviso}
          </p>
        ) : (
          plano && (
            <CaminhoDoAtoFiscal
              estado={{ plano, erro: null, carregando: false }}
              pedirSenha={false}
            />
          )
        )}

        <CampoSenhaDoA1 senha={senha} onSenha={setSenha} obrigatoria />

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onFechar}>
            Voltar
          </Button>
          <Button type="submit" disabled={!pronta}>
            Enviar à SEFAZ
          </Button>
        </div>
      </form>
    </DialogoBase>
  );
}
