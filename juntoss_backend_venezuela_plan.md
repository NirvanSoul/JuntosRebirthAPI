# Juntoss — Plan de implementación Backend
## Soporte monetario avanzado para Venezuela

> Objetivo: incorporar comportamiento monetario específico para usuarios cuyo país de residencia sea Venezuela, sin alterar la experiencia de usuarios de otros países y manteniendo consistencia histórica en movimientos, cuentas, categorías y espacios compartidos.

---

# 1. Principios de arquitectura

La implementación debe tratar Venezuela como una **capa monetaria adicional** y no como una bifurcación completa de la aplicación.

Los principios base son:

1. **El país del usuario define funcionalidades disponibles.**
2. **El backend es la fuente de verdad para tasas, conversiones y snapshots.**
3. **Nunca recalcular movimientos históricos con la tasa actual.**
4. **Cada movimiento conserva su monto original y el contexto de conversión con el que fue creado.**
5. **Las tasas mostradas en vivo pueden cambiar, pero las tasas usadas al guardar un movimiento deben quedar congeladas.**
6. **Los espacios compartidos guardan datos neutrales; cada usuario puede tener su propia preferencia de visualización.**
7. **La lógica Venezuela debe estar desacoplada para poder añadir otros países con reglas especiales en el futuro.**

---

# 2. País de residencia del usuario

## 2.1 Campo requerido

Añadir al perfil del usuario:

```ts
countryCode: string
```

Usar códigos ISO 3166-1 alpha-2.

Ejemplo:

```ts
VE
ES
US
CO
```

Para Venezuela:

```ts
countryCode === "VE"
```

## 2.2 Origen del dato

El país:

- se selecciona durante onboarding;
- se puede modificar posteriormente desde Ajustes;
- no debe depender de IP ni geolocalización;
- debe quedar persistido en backend.

## 2.3 Feature flags derivados

Crear una capa derivada:

```ts
features = {
  venezuelaCurrencyMode: countryCode === "VE"
}
```

No almacenar múltiples booleanos si pueden inferirse directamente del país.

Endpoint recomendado:

```http
GET /me/capabilities
```

Respuesta:

```json
{
  "countryCode": "VE",
  "features": {
    "venezuelaCurrencyMode": true,
    "customExchangeRate": true,
    "multiRateMovementDisplay": true
  }
}
```

---

# 3. Modelo monetario

## 3.1 Monedas base

Para esta funcionalidad se necesitan al menos:

```ts
USD
VES
```

Evitar `BSB`.

El código ISO correcto del bolívar venezolano es:

```ts
VES
```

En UI puede mostrarse como:

```text
Bs.
Bolívares
```

---

# 4. Fuentes de tasa

El sistema debe soportar al menos tres modos de tasa:

```ts
BCV
EURO
CUSTOM
```

Nota de naming:

- `BCV`: tasa oficial del Banco Central de Venezuela frente al USD.
- `EURO`: tasa derivada o directa correspondiente al euro.
- `CUSTOM`: tasa manual definida por el usuario.

Si posteriormente se añade USDT u otra tasa, el sistema debe poder extenderse sin migraciones estructurales grandes.

Enum recomendado:

```ts
type ExchangeRateSource =
  | "BCV"
  | "EURO"
  | "CUSTOM"
```

---

# 5. Servicio de tasas

Crear un módulo único:

```text
exchange-rates/
```

Responsabilidades:

- consultar proveedores externos;
- normalizar tasas;
- cachearlas;
- devolver fecha/hora de actualización;
- identificar fuente;
- manejar fallos;
- persistir histórico cuando sea necesario.

API interna sugerida:

```ts
getCurrentRates("VE")
getRate({
  countryCode: "VE",
  source: "BCV",
  baseCurrency: "USD",
  quoteCurrency: "VES"
})
```

Respuesta normalizada:

```json
{
  "source": "BCV",
  "baseCurrency": "USD",
  "quoteCurrency": "VES",
  "rate": "52.345600",
  "effectiveAt": "2026-09-02T14:00:00.000Z",
  "fetchedAt": "2026-09-02T14:05:11.000Z"
}
```

Usar decimal/string, nunca `float`.

---

# 6. Precisión monetaria

Todos los montos y tasas deben almacenarse con tipos decimales.

Ejemplo PostgreSQL:

```sql
NUMERIC(24, 8)
```

Para dinero:

```sql
NUMERIC(20, 2)
```

si el producto no requiere subcéntimos.

Para tasas:

```sql
NUMERIC(24, 8)
```

No usar `REAL`, `FLOAT` ni `DOUBLE PRECISION` para cálculos monetarios.

---

# 7. Tabla de tasas

Crear una tabla de snapshots/histórico de tasas.

Ejemplo:

```sql
exchange_rates
```

Campos:

```ts
id
countryCode
source
baseCurrency
quoteCurrency
rate
effectiveAt
fetchedAt
provider
metadata
createdAt
```

Índices:

```text
(countryCode, source, effectiveAt)
(baseCurrency, quoteCurrency, effectiveAt)
```

---

# 8. Movimiento — nuevo modelo de datos

Cada movimiento debe guardar siempre:

```ts
originalAmount
originalCurrency
```

Ejemplo:

```json
{
  "originalAmount": "10000.00",
  "originalCurrency": "VES"
}
```

Además, si aplica modo Venezuela:

```ts
exchangeSnapshot
```

No debe depender exclusivamente de una FK a una tasa mutable.

---

# 9. Snapshot monetario del movimiento

Crear una estructura congelada en el momento de creación.

Ejemplo recomendado:

```json
{
  "countryCode": "VE",
  "createdWithCurrency": "VES",
  "rates": {
    "BCV": {
      "rate": "52.345600",
      "baseCurrency": "USD",
      "quoteCurrency": "VES",
      "effectiveAt": "2026-09-02T14:00:00.000Z"
    },
    "EURO": {
      "rate": "61.238400",
      "baseCurrency": "EUR",
      "quoteCurrency": "VES",
      "effectiveAt": "2026-09-02T14:00:00.000Z"
    }
  },
  "customRate": null
}
```

Preferiblemente persistirlo como JSONB o mediante una tabla `movement_exchange_snapshots`.

## Recomendación

Para consultas analíticas frecuentes:

- guardar campos principales normalizados;
- mantener además snapshot JSONB para auditoría.

---

# 10. Movimiento creado en USD

Ejemplo:

```text
Usuario introduce: $10
```

Backend debe guardar:

```json
{
  "originalAmount": "10.00",
  "originalCurrency": "USD"
}
```

Además captura tasas del momento.

Las equivalencias derivadas quedan calculables:

```text
USD → VES usando BCV
USD → VES usando EURO
```

El movimiento histórico siempre sigue siendo:

```text
$10
```

aunque la tasa cambie mañana.

---

# 11. Movimiento creado en VES

Ejemplo:

```text
Usuario introduce: Bs. 10.000
```

Guardar:

```json
{
  "originalAmount": "10000.00",
  "originalCurrency": "VES"
}
```

En el snapshot:

```text
BCV del momento
EURO del momento
CUSTOM, si fue usada
```

La equivalencia USD histórica se calcula usando esa tasa congelada.

Ejemplo:

```text
Bs. 10.000
≈ $190,99 a tasa BCV del 01/09/2026
```

Nunca recalcular esta equivalencia con la tasa actual.

---

# 12. Tasa personalizada

## 12.1 Entidad

Crear:

```text
user_exchange_preferences
```

o:

```text
custom_exchange_rates
```

Campos:

```ts
id
userId
countryCode
name
baseCurrency
quoteCurrency
rate
isDefault
createdAt
updatedAt
```

Ejemplo:

```json
{
  "name": "Mi tasa",
  "baseCurrency": "USD",
  "quoteCurrency": "VES",
  "rate": "54.50"
}
```

## 12.2 Importante

Si un movimiento se guarda con tasa personalizada:

- copiar la tasa al snapshot;
- no depender de la tasa personalizada actual del usuario.

El usuario puede modificar su tasa mañana sin alterar movimientos antiguos.

---

# 13. API para conversión en vivo

El frontend necesita conversión mientras el usuario escribe.

Crear endpoint:

```http
POST /exchange/preview
```

Payload:

```json
{
  "countryCode": "VE",
  "amount": "10000",
  "currency": "VES"
}
```

Respuesta:

```json
{
  "input": {
    "amount": "10000",
    "currency": "VES"
  },
  "conversions": {
    "BCV": {
      "amount": "190.99",
      "currency": "USD",
      "rate": "52.3456"
    },
    "EURO": {
      "amount": "163.30",
      "currency": "EUR",
      "rate": "61.2384"
    }
  },
  "ratesUpdatedAt": "2026-09-02T14:00:00.000Z"
}
```

Este endpoint:

- sirve solo como preview;
- no congela tasas;
- puede usar caché;
- debe ser ligero.

---

# 14. Creación de movimientos

Endpoint actual de crear movimiento debe ampliarse.

Payload Venezuela:

```json
{
  "amount": "10000",
  "currency": "VES",
  "exchangeRateSelection": {
    "displayPreference": "BCV",
    "customRateId": null
  }
}
```

El backend debe:

1. validar país del usuario;
2. validar moneda;
3. obtener tasas actuales;
4. congelar snapshot;
5. persistir movimiento;
6. devolver representación enriquecida.

---

# 15. Idempotencia

Si el frontend reintenta una petición por mala conexión, no debe crear dos movimientos.

Añadir:

```text
Idempotency-Key
```

o un:

```ts
clientMutationId
```

Esto es especialmente importante porque ahora la creación incluye consulta y snapshot de tasas.

---

# 16. Representación de movimiento para frontend

Crear un DTO unificado.

Ejemplo:

```json
{
  "id": "mov_123",
  "amount": {
    "original": {
      "value": "10000.00",
      "currency": "VES"
    },
    "historicalConversions": {
      "BCV": {
        "value": "190.99",
        "currency": "USD",
        "rate": "52.3456"
      },
      "EURO": {
        "value": "163.30",
        "currency": "EUR",
        "rate": "61.2384"
      }
    }
  }
}
```

Evitar obligar al frontend a reconstruir toda la lógica.

---

# 17. Preferencia de visualización

Crear preferencia por usuario:

```ts
venezuelaDisplayRate:
  | "BCV"
  | "EURO"
  | "CUSTOM"
```

Puede almacenarse en:

```text
user_preferences
```

La preferencia controla cómo se presentan agregados y previews.

No modifica los datos originales.

---

# 18. Espacios compartidos

Este es uno de los puntos más importantes.

Los movimientos de un espacio compartido pertenecen al espacio, no a una preferencia monetaria individual.

Guardar:

```text
monto original
moneda original
snapshot histórico
```

Cada miembro puede elegir:

```text
ver a tasa BCV
ver a tasa EURO
ver tasa personalizada
```

La selección es personal.

Nunca sobrescribir el movimiento porque otro miembro cambie su preferencia.

---

# 19. País en espacios compartidos

No asumir que todos los miembros de un espacio viven en Venezuela.

Caso:

```text
Usuario A → Venezuela
Usuario B → España
```

El espacio puede contener movimientos VES.

El usuario español debe poder ver el movimiento original sin que se active toda la experiencia Venezuela.

Regla recomendada:

- las funcionalidades de introducción especial dependen del usuario;
- los datos de un movimiento dependen del movimiento;
- las capacidades de visualización dependen de ambos.

---

# 20. Agregados de categorías

Endpoints de detalle de categoría deberán aceptar parámetros de visualización.

Ejemplo:

```http
GET /categories/:id/summary?displayCurrency=USD&rateSource=BCV
```

Respuesta:

```json
{
  "total": {
    "value": "412.30",
    "currency": "USD",
    "rateSource": "BCV"
  }
}
```

---

# 21. Regla crítica para agregados históricos

Para sumar movimientos históricos:

**cada movimiento debe convertirse usando SU PROPIO snapshot.**

Incorrecto:

```text
sumar todos los VES y convertir el total usando tasa actual
```

Correcto:

```text
movimiento A → convertir con snapshot A
movimiento B → convertir con snapshot B
movimiento C → convertir con snapshot C
sumar resultados
```

Esto representa correctamente el valor histórico.

---

# 22. Agregados de cuentas

Las cuentas necesitan distinguir:

```ts
accountCurrency
```

Ejemplo:

```text
Cuenta bancaria VES
Cuenta USD
Efectivo USD
```

Una cuenta VES puede mostrar:

```text
Saldo principal: Bs.
Equivalencia secundaria: USD según BCV/EURO/CUSTOM
```

---

# 23. Saldo actual vs valor histórico

Separar conceptos.

## Saldo nominal

```text
Bs. 50.000
```

## Equivalencia actual

Puede calcularse con tasa actual:

```text
≈ $954 actualmente
```

## Movimientos históricos

Deben conservar sus snapshots originales.

No mezclar estos dos conceptos.

---

# 24. Preview cards de movimientos

Backend debe devolver datos suficientes para:

```text
monto original
moneda original
equivalencia histórica
fuente de tasa
```

Ejemplo:

```json
{
  "primaryAmount": {
    "value": "10000",
    "currency": "VES"
  },
  "secondaryAmount": {
    "value": "190.99",
    "currency": "USD",
    "source": "BCV"
  }
}
```

---

# 25. Preview cards de categorías

Debe soportar:

```text
total nominal
total convertido
rateSource
```

La conversión debe respetar snapshots individuales.

---

# 26. Preview cards de cuentas

Para cuentas en VES:

```text
Bs. 100.000
≈ $1.900 BCV
```

Para cuentas USD:

```text
$500
≈ Bs. 26.172,80
```

Puede usar tasa actual para saldo actual.

---

# 27. Detalle de movimiento

Endpoint deberá devolver:

```text
monto original
BCV snapshot
EURO snapshot
CUSTOM snapshot
fecha efectiva de tasas
resultado de cada conversión
```

Además:

```text
tasa usada al crear el movimiento
```

---

# 28. Detalle de categoría

Debe permitir cambiar:

```text
BCV
EURO
CUSTOM
```

La selección puede venir como query param.

Ejemplo:

```http
GET /categories/:id?rateSource=EURO
```

---

# 29. Detalle de cuenta

Para cuenta VES:

- saldo nominal;
- equivalencia actual;
- movimientos históricos;
- selector de tasa.

Para cuenta USD:

- saldo USD;
- equivalencia a VES;
- selector de tasa.

---

# 30. Migración de datos existentes

Movimientos antiguos no tendrán snapshot.

Definir explícitamente:

```ts
exchangeSnapshotStatus:
  | "AVAILABLE"
  | "NOT_APPLICABLE"
  | "LEGACY_MISSING"
```

No inventar una tasa histórica.

Para legacy:

```text
Mostrar monto original.
No mostrar equivalencia histórica exacta.
```

Opcionalmente:

```text
"Conversión histórica no disponible"
```

---

# 31. Caché

Las tasas no deben consultarse al proveedor en cada pulsación.

Implementar caché.

Ejemplo:

```text
Cloudflare KV
Redis
cache interna
```

TTL recomendado según proveedor:

```text
5–15 minutos
```

La fecha de actualización siempre debe enviarse al frontend.

---

# 32. Resiliencia ante caída del proveedor

Orden sugerido:

1. tasa actual en caché;
2. última tasa válida persistida;
3. respuesta degradada.

Ejemplo:

```json
{
  "status": "STALE",
  "rate": "52.34",
  "effectiveAt": "...",
  "warning": "RATE_PROVIDER_UNAVAILABLE"
}
```

Nunca devolver 0 como tasa.

---

# 33. Validaciones

Backend debe validar:

```text
amount > 0
currency soportada
rate > 0
source válida
countryCode válido
customRate pertenece al usuario
```

Para espacios compartidos:

```text
usuario pertenece al espacio
movimiento pertenece al espacio
```

---

# 34. Seguridad

Nunca permitir que el frontend envíe arbitrariamente:

```text
historicalRate
```

y confiar en ella como tasa oficial.

Para:

```text
BCV
EURO
```

la tasa debe provenir del backend.

Solo `CUSTOM` puede provenir de una tasa definida por usuario.

---

# 35. Auditoría

Guardar opcionalmente:

```ts
rateProvider
rateProviderReference
snapshotCreatedAt
```

Esto ayudará a depurar discrepancias futuras.

---

# 36. Testing unitario

Crear tests para:

```text
USD → VES BCV
VES → USD BCV
VES → EUR
CUSTOM
redondeos
tasas inválidas
movimientos legacy
```

---

# 37. Testing histórico

Caso obligatorio:

1. crear movimiento con tasa 50;
2. actualizar tasa global a 60;
3. consultar movimiento;
4. verificar que sigue mostrando tasa 50.

---

# 38. Testing de agregados

Ejemplo:

```text
Movimiento 1:
Bs. 5.000
tasa histórica: 50
= $100

Movimiento 2:
Bs. 6.000
tasa histórica: 60
= $100

Total histórico:
$200
```

No:

```text
Bs. 11.000 / tasa actual
```

---

# 39. Testing espacios compartidos

Caso:

```text
Usuario A: VE, preferencia BCV
Usuario B: VE, preferencia EURO
```

Ambos consultan mismo espacio.

Resultado:

```text
mismos movimientos originales
diferente representación secundaria
```

---

# 40. Observabilidad

Añadir métricas/logs:

```text
rate_provider_errors
rate_cache_hits
rate_cache_misses
movement_snapshot_errors
custom_rate_usage
```

Nunca loguear información sensible innecesaria.

---

# 41. Propuesta de endpoints

```http
GET    /me/capabilities
PATCH  /me/country

GET    /exchange/rates
POST   /exchange/preview

GET    /exchange/custom-rates
POST   /exchange/custom-rates
PATCH  /exchange/custom-rates/:id
DELETE /exchange/custom-rates/:id

POST   /movements
GET    /movements/:id

GET    /categories/:id/summary
GET    /accounts/:id/summary
```

---

# 42. Orden recomendado de implementación

## Fase 1 — Base

- countryCode
- capabilities
- enums monetarios
- servicio decimal

## Fase 2 — Tasas

- proveedor
- normalización
- caché
- histórico

## Fase 3 — Movimientos

- originalAmount
- originalCurrency
- snapshot
- DTO enriquecido

## Fase 4 — Custom rate

- CRUD de tasa personalizada
- snapshot CUSTOM

## Fase 5 — Agregados

- categorías
- cuentas
- movimientos
- espacios compartidos

## Fase 6 — Legacy

- migraciones
- estados `LEGACY_MISSING`

## Fase 7 — Hardening

- tests
- métricas
- idempotencia
- resiliencia

---

# 43. Criterios de aceptación Backend

La tarea se considera terminada cuando:

- un usuario VE puede crear movimientos en USD o VES;
- cada movimiento guarda monto y moneda original;
- cada movimiento VE guarda snapshot histórico;
- cambiar la tasa actual no altera movimientos antiguos;
- BCV/EURO se calculan exclusivamente en backend;
- custom rate puede definirse por usuario;
- espacios compartidos funcionan sin duplicar datos;
- agregados convierten cada movimiento con su snapshot;
- cuentas VES pueden devolver equivalencia actual;
- usuarios no VE mantienen exactamente el flujo actual;
- existen tests de regresión y de precisión monetaria.

---

# 44. Recomendación técnica final

No modelar esta funcionalidad como:

```text
"isVenezuela ? hacer X : hacer Y"
```

repetido por todo el backend.

Crear abstracciones:

```text
CountryCapabilitiesService
ExchangeRateService
MoneyConversionService
MovementValuationService
```

De esta forma, Venezuela es la primera implementación de una arquitectura que posteriormente podría soportar otros mercados con reglas cambiarias especiales.
