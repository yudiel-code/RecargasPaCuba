// js/products.js
// B3.1 - Tabla central de productos de recarga

(function (window) {
  const PRODUCTS = {
    // --- CUBACEL ---
    "cubacel-10": {
      id: "cubacel-10",
      tipo: "recarga",
      operador: "Cubacel",
      descripcion: "Recarga Cubacel básica",
      precioTexto: "10,42 €",
      importe: 10.42,
      recibe: "568 CUP + 2 GB",
      monedas: 13
    },
    "cubacel-20": {
      id: "cubacel-20",
      tipo: "recarga",
      operador: "Cubacel",
      descripcion: "Recarga Cubacel promo",
      precioTexto: "20,84 €",
      importe: 20.84,
      recibe: "500 CUP + 4 GB",
      monedas: 27
    },
    "cubacel-25": {
      id: "cubacel-25",
      tipo: "recarga",
      operador: "Cubacel",
      descripcion: "Recarga Cubacel LTE",
      precioTexto: "25,01 €",
      importe: 25.01,
      recibe: "700 CUP + 4 GB LTE",
      monedas: 41
    },

    // --- NAUTA ---
    "nauta-10": {
      id: "nauta-10",
      tipo: "recarga",
      operador: "Nauta",
      descripcion: "Recarga Nauta 10 €",
      precioTexto: "10,00 €",
      importe: 10.0,
      recibe: "Saldo NAUTA equivalente",
      monedas: 5
    },
    "nauta-20": {
      id: "nauta-20",
      tipo: "recarga",
      operador: "Nauta",
      descripcion: "Recarga Nauta 20 €",
      precioTexto: "20,00 €",
      importe: 20.0,
      recibe: "Saldo NAUTA ampliado",
      monedas: 5
    }
  };

  function getById(id) {
    return PRODUCTS[id] || null;
  }

  function getAll() {
    return PRODUCTS;
  }

  window.Products = {
    all: getAll,
    getById
  };
})(window);
