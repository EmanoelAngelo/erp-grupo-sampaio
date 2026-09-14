/**
 * A BANCADA ONDE A OS (OU A MÁQUINA) ENTRA — GAP-PRD-099.
 *
 * As três telas de abertura (o quadro da oficina, o cadastro de equipamento e
 * o PDV do caixa da oficina) mandavam a abertura sem bancada, e o servidor a
 * resolvia pela filiação de quem clicava. O caixa e o atendente não são membros
 * de bancada: levavam 400/403 sempre. O servidor passou a usar a régua de quem
 * ABRE (`GET /core/workshop/entrada`, lida por `useBancadasDeEntrada`), e estas
 * telas perguntam a bancada só quando há mais de uma no alcance — com uma, o
 * campo nem aparece e o servidor a assume.
 */
import { Field } from './ui';
import { precisaEscolherBancada, type BancadaDeEntrada } from '@/lib/api/oficinaEntrada';

export function CampoBancada({
  bancadas,
  value,
  onChange,
}: {
  bancadas: BancadaDeEntrada[] | null;
  value: string;
  onChange: (id: string) => void;
}) {
  if (!precisaEscolherBancada(bancadas)) return null;
  return (
    <Field label="Bancada" required hint="Esta empresa tem mais de uma bancada">
      {(p) => (
        <select
          {...p}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-full px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
            bg-[var(--gs-surface)] text-[var(--gs-text)]"
        >
          <option value="">Escolha a bancada</option>
          {(bancadas ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
