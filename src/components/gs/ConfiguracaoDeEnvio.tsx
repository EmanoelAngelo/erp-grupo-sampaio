/**
 * Como a operação ENVIA pelo provedor (GAP-PRD-120) — as duas decisões que
 * mudam o que a etiqueta leva, com o padrão SEGURO do servidor:
 *
 *   - envio SEM NF-e, com declaração de conteúdo: nasce DESLIGADO. Empresa que
 *     despacha mercadoria vendida emite nota; se a declaração cabe na operação
 *     é pergunta para o contador, não escolha da tela;
 *   - a agência Jadlog: o Melhor Envio exige para serviço Jadlog. Sem ela a
 *     compra é recusada com o nome do campo, em vez de falhar no provedor.
 */
import { useEffect, useState } from 'react';
import { Button, Card, Field, Input } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { enviosApi } from '@/lib/api/envios';

export function ConfiguracaoDeEnvio() {
  const [carregado, setCarregado] = useState(false);
  const [declaracao, setDeclaracao] = useState(false);
  const [agencia, setAgencia] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    enviosApi
      .lerConfiguracao()
      .then((c) => {
        if (!vivo) return;
        setDeclaracao(c.permitirDeclaracaoDeConteudo);
        setAgencia(c.agenciaJadlog ?? '');
        setCarregado(true);
      })
      .catch((err) => {
        if (vivo) setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível ler a configuração de envio.');
      });
    return () => {
      vivo = false;
    };
  }, []);

  const salvar = async () => {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      const c = await enviosApi.salvarConfiguracao({
        permitirDeclaracaoDeConteudo: declaracao,
        agenciaJadlog: agencia.trim() || null,
      });
      setDeclaracao(c.permitirDeclaracaoDeConteudo);
      setAgencia(c.agenciaJadlog ?? '');
      setAviso('Configuração de envio guardada.');
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível guardar.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Card
      title="Envio e etiqueta"
      subtitle="O que vai na etiqueta comprada pelo Melhor Envio, na ficha de cada pedido."
    >
      <div className="flex flex-col gap-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={declaracao}
            disabled={!carregado || ocupado}
            onChange={(e) => setDeclaracao(e.target.checked)}
            className="mt-1"
          />
          <span>
            <strong className="block">Permitir envio sem NF-e (declaração de conteúdo)</strong>
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Desligado, a etiqueta só é comprada com a NF-e autorizada do pedido — é o padrão. Ligue
              só com o de acordo do contador: empresa que despacha mercadoria vendida emite nota.
            </span>
          </span>
        </label>

        <div className="max-w-xs">
          <Field
            label="Agência Jadlog (número no Melhor Envio)"
            hint="Obrigatória para comprar etiqueta de serviço Jadlog. Fica na lista de agências do Melhor Envio."
          >
            {(p) => (
              <Input
                {...p}
                inputMode="numeric"
                value={agencia}
                disabled={!carregado || ocupado}
                onChange={(e) => setAgencia(e.target.value)}
              />
            )}
          </Field>
        </div>

        <div>
          <Button loading={ocupado} disabled={!carregado} onClick={() => void salvar()}>
            Guardar
          </Button>
        </div>

        {aviso && (
          <p role="status" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-success)]">
            {aviso}
          </p>
        )}
        {erro && (
          <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
            {erro}
          </p>
        )}
      </div>
    </Card>
  );
}
