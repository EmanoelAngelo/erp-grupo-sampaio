/**
 * AS FOTOS DA MÁQUINA, na ficha (GAP-PRD-106).
 *
 * As fotos existiam só na OS: o estado da lataria e do painel ficava preso a
 * uma visita. Estas acompanham a máquina — a oficina fotografa uma vez e toda
 * OS seguinte (e o pós-venda) vê. A imagem é reduzida no navegador antes de
 * subir (a do celular sai com vários MB; o servidor aceita 3 MB).
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Field } from './ui';
import { useConfirmar } from './PerguntaDaTela';
import { ApiRequestError } from '@/lib/api/client';
import { normalizeImage } from '@/lib/image';
import {
  TIPOS_DE_FOTO,
  equipamentoIdentidadeApi,
  type FotoDaMaquina,
} from '@/lib/api/equipamentoIdentidade';

export function FotosDoEquipamentoCard({
  equipmentId,
  podeSubir,
  podeApagar,
}: {
  equipmentId: string;
  podeSubir: boolean;
  podeApagar: boolean;
}) {
  const [fotos, setFotos] = useState<FotoDaMaquina[] | null>(null);
  const [tipo, setTipo] = useState('frente');
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    try {
      setFotos(await equipamentoIdentidadeApi.fotos(equipmentId));
    } catch (err) {
      setFotos([]);
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível carregar as fotos.');
    }
  }, [equipmentId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const subir = async (arquivo: File | undefined) => {
    if (!arquivo) return;
    setErro(null);
    setOcupado(true);
    try {
      const imagem = await normalizeImage(arquivo);
      await equipamentoIdentidadeApi.subirFoto(equipmentId, { dataUrl: imagem.dataUrl, kind: tipo });
      await carregar();
    } catch (err) {
      setErro(
        err instanceof ApiRequestError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Não foi possível subir a foto.',
      );
    } finally {
      setOcupado(false);
    }
  };

  // A pergunta da tela no lugar de window.confirm (GAP-PRD-158).
  const { confirmar, dialogoDeConfirmacao } = useConfirmar();

  const apagar = async (foto: FotoDaMaquina) => {
    const certeza = await confirmar({
      titulo: 'Apagar esta foto da máquina?',
      mensagem: 'Ela sai do histórico de fotos.',
      confirmar: 'Apagar a foto',
      perigoso: true,
    });
    if (!certeza) return;
    setErro(null);
    try {
      await equipamentoIdentidadeApi.apagarFoto(equipmentId, foto.id);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível apagar a foto.');
    }
  };

  const rotuloDoTipo = (k: string) => TIPOS_DE_FOTO.find((t) => t.value === k)?.label ?? k;

  return (
    <Card
      title={`Fotos da máquina${fotos ? ` (${fotos.length})` : ''}`}
      subtitle="Acompanham a máquina em todas as OS — não só na visita em que foram tiradas."
      className="mb-5"
    >
      {fotos === null ? (
        <p role="status" className="m-0 text-[var(--gs-muted)]">
          Carregando…
        </p>
      ) : fotos.length === 0 ? (
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Nenhuma foto da máquina ainda.
        </p>
      ) : (
        <ul className="list-none p-0 m-0 grid gap-3 grid-cols-2 sm:grid-cols-4">
          {fotos.map((f) => (
            <li key={f.id} className="flex flex-col gap-1">
              <a href={f.url} target="_blank" rel="noreferrer">
                <img
                  src={f.url}
                  alt={`Foto da máquina: ${rotuloDoTipo(f.kind)}`}
                  className="w-full aspect-square object-cover rounded-[var(--gs-radius)] border border-[var(--gs-border)]"
                />
              </a>
              <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                {rotuloDoTipo(f.kind)}
                {f.caption ? ` · ${f.caption}` : ''}
              </span>
              {podeApagar && (
                <Button size="sm" variant="ghost" onClick={() => void apagar(f)}>
                  Apagar
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {podeSubir && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="Tipo da foto">
            {(p) => (
              <select
                {...p}
                value={tipo}
                onChange={(e) => setTipo(e.target.value)}
                className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
              >
                {TIPOS_DE_FOTO.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Arquivo da foto" hint="JPEG, PNG ou WebP. Reduzida antes de subir.">
            {(p) => (
              <input
                {...p}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={ocupado}
                onChange={(e) => {
                  void subir(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            )}
          </Field>
        </div>
      )}

      {erro && (
        <p role="alert" className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
      {dialogoDeConfirmacao}
    </Card>
  );
}
