/**
 * CORRIGIR A IDENTIDADE DA MÁQUINA, pela ficha (GAP-PRD-106).
 *
 * Marca, modelo, chassi, série e tipo não tinham porta de correção: o erro de
 * digitação virava plaquinha errada para sempre. Aqui a bancada corrige, com
 * motivo — o histórico da máquina guarda cada campo "antes → depois".
 *
 * Só vai ao servidor o que MUDOU: mandar o formulário inteiro faria cada
 * correção parecer mexer em tudo, e o histórico perderia a leitura.
 *
 * Máquina vinculada a uma unidade da loja: chassi, motor e série vêm de lá (é
 * o número do documento fiscal da venda). Os três ficam travados, com a frase
 * que diz onde corrigir.
 */
import { useMemo, useState } from 'react';
import { Button, Card, Field, Input } from './ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  CATEGORIAS_DE_EQUIPAMENTO,
  equipamentoIdentidadeApi,
  temPlacaEKm,
} from '@/lib/api/equipamentoIdentidade';

/** Campo da tela → campo da API e coluna da máquina. */
const CAMPOS = [
  { api: 'category', coluna: 'category', rotulo: 'Tipo' },
  { api: 'brand', coluna: 'brand', rotulo: 'Marca' },
  { api: 'model', coluna: 'model', rotulo: 'Modelo' },
  { api: 'version', coluna: 'version', rotulo: 'Versão' },
  { api: 'color', coluna: 'color', rotulo: 'Cor' },
  { api: 'year', coluna: 'year', rotulo: 'Ano de fabricação' },
  { api: 'serialNumber', coluna: 'serial_number', rotulo: 'Número de série' },
  { api: 'chassis', coluna: 'chassis', rotulo: 'Chassi' },
  { api: 'motorNumber', coluna: 'motor_number', rotulo: 'Número do motor' },
  { api: 'battery', coluna: 'battery', rotulo: 'Bateria' },
  { api: 'batterySerial', coluna: 'battery_serial', rotulo: 'Série da bateria' },
  { api: 'plate', coluna: 'plate', rotulo: 'Placa' },
  { api: 'odometerKm', coluna: 'odometer_km', rotulo: 'Quilometragem' },
  { api: 'notes', coluna: 'notes', rotulo: 'Observações' },
] as const;

const TRAVADOS_PELA_UNIDADE = new Set(['serialNumber', 'chassis', 'motorNumber']);
/** Não são identidade: entram sem motivo (o km que volta, o servidor pergunta). */
const SEM_MOTIVO = new Set(['odometerKm', 'notes']);

export function CorrigirIdentidadeCard({
  equipmentId,
  equipamento,
  lojaDoVinculo,
  onCorrigida,
  onCancelar,
}: {
  equipmentId: string;
  equipamento: Record<string, unknown>;
  /** Nome da loja cuja unidade manda em chassi, motor e série; nulo sem vínculo. */
  lojaDoVinculo: string | null;
  onCorrigida: () => void;
  onCancelar: () => void;
}) {
  const original = useMemo(
    () =>
      Object.fromEntries(
        CAMPOS.map((c) => [c.api, equipamento[c.coluna] === null || equipamento[c.coluna] === undefined ? '' : String(equipamento[c.coluna])]),
      ) as Record<string, string>,
    [equipamento],
  );
  const [valores, setValores] = useState<Record<string, string>>(original);
  const [motivo, setMotivo] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const mudados = CAMPOS.filter((c) => (valores[c.api] ?? '').trim() !== (original[c.api] ?? '').trim());
  const pedeMotivo = mudados.some((c) => !SEM_MOTIVO.has(c.api));
  const categoriaAtual = valores.category ?? '';
  const categoriaForaDoVocabulario =
    Boolean(original.category) && !CATEGORIAS_DE_EQUIPAMENTO.some((c) => c.value === original.category);

  const salvar = async () => {
    setErro(null);
    if (mudados.length === 0) {
      setErro('Nada mudou.');
      return;
    }
    if (pedeMotivo && !motivo.trim()) {
      setErro('Diga o motivo da correção: é o que o histórico da máquina mostra depois.');
      return;
    }
    const corpo: Record<string, unknown> = {};
    for (const c of mudados) {
      const v = (valores[c.api] ?? '').trim();
      corpo[c.api] = c.api === 'odometerKm' || c.api === 'year' ? (v ? Number(v) : null) : v || null;
    }
    if (motivo.trim()) corpo.motivo = motivo.trim();
    setOcupado(true);
    try {
      await equipamentoIdentidadeApi.corrigir(equipmentId, corpo);
      onCorrigida();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível corrigir a identidade.');
    } finally {
      setOcupado(false);
    }
  };

  const campo = (api: string) => CAMPOS.find((c) => c.api === api)!;
  const entrada = (api: string, extra: { inputMode?: 'numeric'; placeholder?: string } = {}) => {
    const travado = Boolean(lojaDoVinculo) && TRAVADOS_PELA_UNIDADE.has(api);
    return (
      <Field
        key={api}
        label={campo(api).rotulo}
        hint={travado ? `Vem da unidade de estoque da ${lojaDoVinculo}: corrija por lá.` : undefined}
      >
        {(p) => (
          <Input
            {...p}
            {...extra}
            disabled={travado}
            value={valores[api] ?? ''}
            onChange={(e) =>
              setValores((v) => ({
                ...v,
                [api]:
                  api === 'odometerKm' || api === 'year'
                    ? e.target.value.replace(/\D/g, '').slice(0, api === 'year' ? 4 : 7)
                    : e.target.value,
              }))
            }
          />
        )}
      </Field>
    );
  };

  return (
    <Card title="Corrigir identidade" className="mb-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Tipo"
          hint={
            categoriaForaDoVocabulario
              ? `Gravado como "${original.category}", fora da lista: escolha o tipo certo.`
              : 'Decide o que a ficha pergunta (celular não tem placa nem km).'
          }
        >
          {(p) => (
            <select
              {...p}
              value={categoriaAtual}
              onChange={(e) => {
                const categoria = e.target.value;
                // Virar celular leva embora placa e km: o servidor recusaria
                // um celular emplacado, e o campo nem aparece mais na tela.
                setValores((v) => ({
                  ...v,
                  category: categoria,
                  ...(temPlacaEKm(categoria) ? {} : { plate: '', odometerKm: '' }),
                }));
              }}
              className="h-10 w-full px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
            >
              <option value="">Não informado</option>
              {categoriaForaDoVocabulario && (
                <option value={original.category}>{original.category} (antigo)</option>
              )}
              {CATEGORIAS_DE_EQUIPAMENTO.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {entrada('brand')}
        {entrada('model')}
        {entrada('version')}
        {entrada('color')}
        {entrada('year', { inputMode: 'numeric', placeholder: '2024' })}
        {entrada('serialNumber')}
        {entrada('chassis')}
        {entrada('motorNumber')}
        {entrada('battery')}
        {entrada('batterySerial')}
        {temPlacaEKm(categoriaAtual) && entrada('plate', { placeholder: 'ABC1D23' })}
        {temPlacaEKm(categoriaAtual) && entrada('odometerKm', { inputMode: 'numeric', placeholder: '1200' })}
      </div>
      <div className="mt-4">{entrada('notes')}</div>
      <div className="mt-4">
        <Field
          label="Motivo da correção"
          required={pedeMotivo}
          hint="Obrigatório para mudar a identidade. Quilometragem nova e observações entram sem motivo."
        >
          {(p) => (
            <textarea
              {...p}
              rows={2}
              maxLength={300}
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Ex.: chassi digitado errado na entrada"
              className="w-full px-3 py-2 border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)]"
            />
          )}
        </Field>
      </div>
      {erro && (
        <p role="alert" className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
      <div className="flex gap-2 mt-3">
        <Button loading={ocupado} disabled={mudados.length === 0} onClick={() => void salvar()}>
          Salvar correção
        </Button>
        <Button variant="ghost" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </Card>
  );
}
