import { describe, expect, it } from "vitest";
import { FakeRevgasClient } from "../../src/revgas/fakeClient.js";
import { RevgasError, type SalePayload } from "../../src/revgas/types.js";

const sale: SalePayload = {
  location: "Rua A",
  number: "1",
  neighborhood: "Centro",
  city: "Teresina",
  state_federation: "PI",
  establishment_id: 2580,
  products: [{ product_id: 23740, quantity: 2, value: 110 }],
  payments: [{ payment_type: "PIX", value: 220 }],
  channel: "WHATSAPP",
  origin: "INTEGRATION",
  option: "NORMAL",
  broadcast: "NONE",
};

describe("FakeRevgasClient", () => {
  it("records created sales and returns them by id", async () => {
    const fake = new FakeRevgasClient();
    const created = await fake.createSale(sale);
    expect(created).toMatchObject({ status: "OPEN", total: 220 });
    expect(fake.sales).toHaveLength(1);
    expect(await fake.getSale(created.id)).toEqual(created);
  });

  it("fails the next createSale once when failNextCreateWith is set", async () => {
    const fake = new FakeRevgasClient();
    fake.failNextCreateWith = new RevgasError("network");
    await expect(fake.createSale(sale)).rejects.toMatchObject({ kind: "network" });
    expect(fake.sales).toHaveLength(0);
    await expect(fake.createSale(sale)).resolves.toMatchObject({ status: "OPEN" });
  });

  it("finds customers by normalized phone", async () => {
    const fake = new FakeRevgasClient();
    fake.customers.push({
      id: 1,
      name: "Maria",
      phone: "86999998888",
      location: "Rua das Flores",
      number: "120",
      neighborhood: "Centro",
      city: "Teresina",
      state_federation: "PI",
      complement: null,
      landmark: null,
    });
    expect(await fake.findCustomersByPhone("+55 (86) 99999-8888")).toHaveLength(1);
    expect(await fake.findCustomersByPhone("86988887777")).toHaveLength(0);
  });

  it("lists only products of the establishment", async () => {
    const fake = new FakeRevgasClient();
    fake.products.push(
      { id: 1, description: "A", inactive: false, establishment_id: 2580 },
      { id: 2, description: "B", inactive: false, establishment_id: 2601 },
    );
    expect((await fake.listProducts(2580)).map((p) => p.id)).toEqual([1]);
  });

  it("rejects an unknown sale id", async () => {
    await expect(new FakeRevgasClient().getSale(1)).rejects.toMatchObject({ kind: "invalid" });
  });
});
