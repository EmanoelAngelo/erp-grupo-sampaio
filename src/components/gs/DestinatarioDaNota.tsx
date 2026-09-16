/**
 * ============================================================================
 * O DESTINATÁRIO DE UMA NF-e — um formulário só, em toda tela que emite
 * ============================================================================
 *
 * A NF-e (modelo 55) exige o destinatário com ENDEREÇO e o código IBGE do
 * município — é assim que a nota identifica a cidade, e não pelo nome. A NFC-e
 * do balcão não exige nada disso: sai com o CPF, ou sem ele.
 *
 * É por isso que este formulário existe e por que ele PERGUNTA em vez de o
 * sistema adivinhar: o endereço de quem compra no balcão a loja não tem
 * (`core_customers` guarda endereço como texto livre, sem município separado
 * nem IBGE). Inventar endereço seria pôr dado falso numa nota fiscal — e nota
 * com endereço errado é recusada pela SEFAZ depois de numerada, ou pior,
 * autorizada errada.
 *
 * O que o sistema JÁ SABE — nome e CPF/CNPJ que foram para a nota da venda —
 * vem preenchido por quem usa o formulário. O município é escolhido na lista
 * oficial (`CidadeComSugestoes`): ninguém digita os 7 dígitos do IBGE.
 *
 * Duas telas emitem NF-e a partir de uma venda: a ficha da devolução (a nota
 * de entrada, finalidade 4) e a ficha da venda (a nota da venda de balcão).
 * Um formulário só — duas cópias divergiriam no primeiro campo novo do
 * leiaute. As funções puras moram em `@/lib/destinatarioDaNota`.
 */
import { Field, Input } from '@/components/gs/ui';
import { CidadeComSugestoes } from '@/components/gs/CidadeComSugestoes';
import { UFS } from '@/lib/api/municipios';
import {
  documentoDoDestinatarioConfere,
  type RascunhoDoDestinatario,
} from '@/lib/destinatarioDaNota';

export function FormularioDoDestinatario({
  valor,
  onMudar,
}: {
  valor: RascunhoDoDestinatario;
  onMudar: (f: RascunhoDoDestinatario) => void;
}) {
  const set = (chave: keyof RascunhoDoDestinatario) => (texto: string) =>
    onMudar({ ...valor, [chave]: texto });

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Field label="Nome do cliente" required>
        {(p) => <Input {...p} value={valor.name} onChange={(e) => set('name')(e.target.value)} />}
      </Field>
      <Field
        label="CPF ou CNPJ"
        required
        error={
          valor.document && !documentoDoDestinatarioConfere(valor.document)
            ? 'CPF tem 11 dígitos; CNPJ, 14.'
            : undefined
        }
      >
        {(p) => <Input {...p} value={valor.document} onChange={(e) => set('document')(e.target.value)} />}
      </Field>
      <Field label="CEP">
        {(p) => <Input {...p} value={valor.zip} onChange={(e) => set('zip')(e.target.value)} />}
      </Field>
      <Field label="Logradouro" required>
        {(p) => <Input {...p} value={valor.street} onChange={(e) => set('street')(e.target.value)} />}
      </Field>
      <Field label="Número" required>
        {(p) => <Input {...p} value={valor.number} onChange={(e) => set('number')(e.target.value)} />}
      </Field>
      <Field label="Complemento">
        {(p) => <Input {...p} value={valor.complement} onChange={(e) => set('complement')(e.target.value)} />}
      </Field>
      <Field label="Bairro" required>
        {(p) => <Input {...p} value={valor.district} onChange={(e) => set('district')(e.target.value)} />}
      </Field>
      <Field label="UF" required>
        {(p) => (
          <select
            {...p}
            value={valor.uf}
            // Trocar a UF apaga a cidade E o código: o par vinha da UF anterior.
            onChange={(e) => onMudar({ ...valor, uf: e.target.value, cityName: '', cityIbge: '' })}
            className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)]
              bg-[var(--gs-surface)] px-3 py-2"
          >
            <option value="">—</option>
            {UFS.map((uf) => (
              <option key={uf} value={uf}>
                {uf}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Município" required hint="Escolha na lista: o código IBGE vem junto.">
        {(p) => (
          <CidadeComSugestoes
            {...p}
            uf={valor.uf}
            valor={valor.cityName}
            // Digitar apaga o código: ele era da cidade de antes.
            onDigitar={(nome) => onMudar({ ...valor, cityName: nome, cityIbge: '' })}
            onEscolher={(m) => onMudar({ ...valor, cityName: m.nome, cityIbge: m.codigo, uf: m.uf })}
          />
        )}
      </Field>
    </div>
  );
}
