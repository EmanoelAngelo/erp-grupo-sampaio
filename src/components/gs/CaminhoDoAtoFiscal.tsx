/**
 * PARA ONDE ESTE ATO VAI — o quadro dos diálogos de cancelamento, carta de
 * correção e inutilização (GAP-PRD-005).
 *
 * O gerente precisa ler, antes de confirmar, se o ato vai à SEFAZ (e em qual
 * ambiente), se é simulado (nota de ensaio, sem valor fiscal) ou por que não
 * pode sair. E, quando a política do dono pede — ou quando o cofre não tem a
 * senha selada —, é aqui que ele digita a senha do certificado. A senha não
 * fica guardada na tela depois do envio: vive só no estado do diálogo aberto.
 */
import { Field, Input } from '@/components/gs/ui';
import type { EstadoDoPlano } from '@/components/gs/planoDoAtoFiscal';

const AMBIENTE_ROTULO: Record<string, string> = {
  homologation: 'homologação — sem valor fiscal',
  production: 'produção',
};

/**
 * O campo da senha do A1 — o mesmo nos diálogos dos atos sobre nota e no
 * diálogo da Entrada de notas (GAP-PRD-168), para a senha ter um jeito só de
 * ser pedida.
 */
export function CampoSenhaDoA1({
  senha,
  onSenha,
  obrigatoria,
}: {
  senha: string;
  onSenha: (valor: string) => void;
  obrigatoria: boolean;
}) {
  return (
    <Field
      label="Senha do certificado A1"
      required={obrigatoria}
      hint={
        obrigatoria
          ? 'Obrigatória para este ato. Ela não fica guardada nesta tela.'
          : 'Opcional: em branco, vale o certificado guardado no cofre desta operação.'
      }
    >
      {(p) => (
        <Input
          {...p}
          type="password"
          autoComplete="off"
          value={senha}
          onChange={(e) => onSenha(e.target.value)}
        />
      )}
    </Field>
  );
}

export function CaminhoDoAtoFiscal({
  estado,
  senha = '',
  onSenha,
  pedirSenha = true,
}: {
  estado: EstadoDoPlano;
  senha?: string;
  onSenha?: (valor: string) => void;
  /**
   * `false`: só o caminho, sem o campo — o quadro da Entrada de notas diz
   * para onde o ato vai, e a senha, quando pedida, vem no diálogo do ato.
   */
  pedirSenha?: boolean;
}) {
  if (estado.carregando) {
    return (
      <p role="status" className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
        Conferindo como este ato vai à SEFAZ…
      </p>
    );
  }

  if (!estado.plano) {
    return (
      <p role="status" className="text-[length:var(--gs-text-sm)] text-[var(--gs-warning)] m-0">
        {estado.erro ?? 'Não foi possível conferir como este ato vai à SEFAZ.'} O servidor confere
        de novo ao confirmar.
      </p>
    );
  }

  const { plano } = estado;

  if (plano.caminho === 'BLOQUEADO') {
    return (
      <div
        role="alert"
        data-caminho="BLOQUEADO"
        className="px-4 py-3 rounded-[var(--gs-radius)] border-2 border-[var(--gs-danger)]
          bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
      >
        <strong className="block">Este ato não pode sair agora.</strong>
        {plano.motivo}
      </div>
    );
  }

  if (plano.caminho === 'SIMULADOR') {
    return (
      <div
        role="status"
        data-caminho="SIMULADOR"
        className="px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-warning)]
          bg-[var(--gs-warning-bg)] text-[var(--gs-warning)] text-[length:var(--gs-text-sm)]"
      >
        <strong className="block">Simulador — sem valor fiscal.</strong>
        {plano.motivo}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-caminho="SEFAZ">
      <div
        role="status"
        className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)]
          text-[var(--gs-info)] text-[length:var(--gs-text-sm)]"
      >
        <strong className="block">
          Vai à SEFAZ ({AMBIENTE_ROTULO[plano.ambiente] ?? plano.ambiente}).
        </strong>
        {plano.motivo}
      </div>

      {pedirSenha && onSenha && plano.senha !== 'NAO_SE_APLICA' && (
        <CampoSenhaDoA1
          senha={senha}
          onSenha={onSenha}
          obrigatoria={plano.senha === 'OBRIGATORIA'}
        />
      )}
    </div>
  );
}
