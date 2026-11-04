# Tasa USDT (Venezuela) y hora en los movimientos

**Fecha:** 2026-11-04
**Estado (actualizado 2026-11-04):**

| Fase | Contenido | Estado |
|---|---|---|
| **1** | Espejo de tasas de Kuanto, cron, USDT en `/v1/exchange/rates`, `/v1/exchange/preview`, `/v1/exchange-rates/*`, `/v1/rates/venezuela`; `usdtReferenceRate` en capabilities; `/v1/exchange/rates/at` y `/v1/exchange/rates/history` | **Implementada en el backend, sin desplegar** |
| **2** | `occurredAt` + `occurredTimeZone` en movimientos, tasa por fecha/hora del movimiento, `occurredOn`/`occurredAt` en el preview, fila USDT en `exchangeSnapshot`, backfill | **Pendiente** |

Las secciones marcadas **(Fase 2)** describen el contrato acordado pero **todavía no existen** en el API.
**Alcance:** backend (este repo, `Juntos API`) y app móvil de Juntos (repo aparte).

---

## 0. Resumen en 30 segundos

Dos cambios independientes que se entregan juntos:

| # | Cambio | Para quién | Dónde se ve en la app |
|---|---|---|---|
| A | Nueva tasa **USDT** (promedio P2P Binance + Bybit) | **Solo usuarios de Venezuela** (`features.usdtReferenceRate === true`) | Una opción más, **"USDT"**, en el botón conmutable que ya alterna **BCV $** / **EUR** |
| B | **Hora y minutos** del movimiento | **Todos los usuarios** | Una fila nueva **"Hora"** en el **tab de detalles del movimiento**, editable. Ningún otro modal cambia |

Reglas de producto que no se negocian:

- Los usuarios que no son de Venezuela **no ven nada de USDT**, en ninguna parte.
- La hora **solo** aparece y se edita en el tab de detalles del movimiento. **No** se toca el modal de crear movimiento, ni el de editar, ni filtros, ni listas, ni reportes.
- La app **nunca** habla con Supabase. Todo sale del API de Juntos.

---

## 1. De dónde sale el USDT (contexto backend)

- Kuanto (kuanto.online y su app móvil) ya calcula y guarda las tasas en la tabla `daily_rates` de su proyecto Supabase `kuanto-mobile` (`ghyznbisjcdmtuaelhmg`). Hay una fila por día con `bcv_usd`, `bcv_eur`, `p2p_average` (último valor USDT, se sobrescribe durante el día), `p2p_daily_average`, `p2p_sources` (Binance y Bybit, compra y venta) y `p2p_observed_at`.
- Historial disponible: **BCV desde 2023-01-04** y **USDT desde 2026-01-19**.
- Juntos **copia** esos datos a su propia base (Postgres de `DATABASE_URL`) con un cron. Los usuarios solo consultan a Juntos, así que la carga sobre Supabase es mínima: unas 48 lecturas de una fila al día, más una copia inicial del historial.
- Kuanto actualiza el USDT **cada hora, a los :05**. Juntos copia a los **:10 y :40**, así que el USDT de Juntos va como mucho ~5–35 minutos detrás del de Kuanto.
- **Limitación importante:** Supabase **no** guarda el USDT hora por hora, solo el último valor y el promedio del día. Por eso:
  - Para fechas **anteriores** al despliegue de este cambio solo existe el **promedio del día**.
  - **Desde el despliegue**, Juntos guarda cada lectura (cada 30 min), y para movimientos con hora se usa la lectura más cercana anterior a esa hora.

---

## 2. Contrato del API (lo que la app consume)

Todos los cambios del API son **aditivos**: ningún campo existente cambia de nombre ni de tipo.

### 2.1 Capabilities: cómo sabe la app si mostrar USDT

`GET /v1/me/capabilities`

```jsonc
{
  "data": {
    "countryCode": "VE",
    "features": {
      "venezuelaCurrencyMode": true,
      "customExchangeRate": true,
      "multiRateMovementDisplay": true,
      "usdtReferenceRate": true        // NUEVO. true solo si countryCode === "VE"
    }
  }
}
```

**App:**
- Mostrar USDT **solo** si `features.usdtReferenceRate === true`. No comparar `countryCode === "VE"` a mano: el backend es la única fuente de verdad.
- Si el campo no viene (backend viejo), tratarlo como `false`.
- Volver a leer las capabilities cuando el usuario cambie de país (ya debería hacerse así con `venezuelaCurrencyMode`).

### 2.2 Tasas vigentes

`GET /v1/exchange/rates` (público, como hoy)

```jsonc
{
  "data": {
    "rates": {
      "BCV":  { "source": "BCV",  "baseCurrency": "USD",  "quoteCurrency": "VES", "rate": "893.2173000000", "observedAt": "...", "fetchedAt": "..." },
      "EURO": { "source": "EURO", "baseCurrency": "EUR",  "quoteCurrency": "VES", "rate": "999.7691920000", "observedAt": "...", "fetchedAt": "..." },
      "USDT": {                                    // NUEVO. Puede ser null
        "source": "USDT",
        "baseCurrency": "USDT",
        "quoteCurrency": "VES",
        "rate": "1010.0229500000",                // último valor observado
        "dailyAverage": "1008.8891290000",        // promedio del día VE en curso
        "observedAt": "2026-11-04T15:05:02.510Z", // cuándo se observó en el P2P
        "fetchedAt": "2026-11-04T15:30:00.000Z",
        "stale": false                            // true si observedAt tiene más de 2 h
      }
    },
    "ratesUpdatedAt": "...",
    "stale": false
  }
}
```

`GET /v1/exchange-rates/current?source=USDT` devuelve la misma forma que `source=BCV` (`stale` es el del USDT); si no hay USDT responde `502 VENEZUELA_RATES_UNAVAILABLE`.

`GET /v1/rates/venezuela` (público) añade un tercer elemento al arreglo `rates`:
`{ "source": "USDT", "baseCurrency": "USDT", "quoteCurrency": "VES", "rate": "..." }`.

**App:**
- `rates.USDT` **puede ser `null`** si la fuente USDT falla. En ese caso BCV y EUR siguen llegando normalmente: la caída del USDT **nunca** tumba BCV ni EUR. Si es `null`, la opción USDT del botón se muestra deshabilitada o con "No disponible". No se oculta, para que el botón no "salte".
- Si `rates.USDT.stale === true`, mostrar "Actualizado hace X" usando `observedAt`.
- La tasa USDT cambia durante el día. El polling o refresco que ya exista para BCV debe cubrir también USDT. No hace falta refrescar más seguido que cada 30 minutos.

### 2.2b Tasas de una fecha e historial (nuevo, Fase 1)

No hacen falta para las features A y B, pero quedan disponibles (por ejemplo para un gráfico o para mostrar "la tasa de ese día").

`GET /v1/exchange/rates/at?date=YYYY-MM-DD&time=HH:mm` (`time` opcional, **hora de Caracas**; `date` como mucho mañana). Es una consulta de mercado venezolano, por eso usa la hora de Venezuela; los movimientos usan UTC (2.4).

```jsonc
{
  "data": {
    "date": "2026-08-15",
    "time": "14:30",
    "bcv": { "effectiveDate": "2026-08-14", "usd": "…", "eur": "…" },   // null si no hay datos
    "usdt": { "rate": "…", "precision": "daily_average", "observedAt": null } // null antes de 2026-01-19
  }
}
```

- BCV de un fin de semana o feriado: la última publicación anterior (`effectiveDate` indica cuál).
- Reglas del USDT: las mismas de la tabla de 2.5.

`GET /v1/exchange/rates/history?from=YYYY-MM-DD&to=YYYY-MM-DD` (máximo 366 días)

```jsonc
{ "data": { "from": "…", "to": "…", "rates": [ { "date": "2026-08-15", "bcvUsd": "…", "bcvEur": "…", "usdtDailyAverage": "…" } ] } }
```

Una fila por día que exista en el historial. `bcvUsd`/`bcvEur` vienen `null` los fines de semana y feriados.

### 2.3 Preview de conversión (pantalla de creación)

> **Fase 1:** ya devuelve `conversions.USDT` (con la tasa actual) y `/v1/exchange-rates/preview` acepta `"source": "USDT"`.
> **Fase 2:** `occurredOn`/`occurredAt` en el request todavía **no** se aceptan (un campo extra da `400`).

`POST /v1/exchange/preview`

```jsonc
// request
{
  "countryCode": "VE",
  "amount": "100.00",
  "currency": "USD",
  "occurredOn": "2026-08-15",            // NUEVO, opcional. Si falta = hoy
  "occurredAt": "2026-08-15T18:30:00Z"   // NUEVO, opcional. Instante UTC (ver 2.4)
}
// response
{
  "data": {
    "input": { "amount": "100.00", "currency": "USD" },
    "conversions": {
      "BCV":  { "amount": "...", "currency": "VES", "rate": "..." },
      "EURO": { "amount": "...", "currency": "VES", "rate": "..." },
      "USDT": { "amount": "...", "currency": "VES", "rate": "..." }   // NUEVO, puede ser null
    },
    "ratesUpdatedAt": "..."
  }
}
```

`POST /v1/exchange-rates/preview` (contrato reducido) acepta `"source": "USDT"` además de `"BCV"`, y también `occurredOn`/`occurredAt` opcionales. El equipo de la app debe confirmar **cuál de los dos previews usa hoy** y aplicar el cambio solo en ese.

**App:**
- Si el usuario elige una **fecha pasada** en el modal de creación, enviar `occurredOn` en el preview. Así el monto convertido que ve antes de guardar coincide con el que el servidor va a congelar (ver 2.5).
- El modal de creación **no** cambia visualmente: no se añade selector de hora. `occurredAt` solo se envía en el preview si el movimiento ya lo tiene (ver 3.2).

### 2.4 Movimiento: hora en UTC, `occurredAt` + `occurredTimeZone` (Fase 2)

**Principio:** el backend guarda el instante en **UTC** (GMT), como ya hace con todas las demás fechas con hora del sistema, y **la app lo convierte a la hora del teléfono** al mostrarlo.

Aplica a **todas** las representaciones de un movimiento:

| Superficie | Ruta |
|---|---|
| REST: crear | `POST /v1/spaces/:spaceId/transactions` |
| REST: editar | `PATCH /v1/spaces/:spaceId/transactions/:id` |
| REST: listar y leer | `GET /v1/spaces/:spaceId/transactions[/:id]` |
| Sync: subida | `POST /v1/spaces/:spaceId/sync` (arreglo `transactions`) |
| Sync: bajada | `/v1/sync/snapshot` y `/v1/sync/changes` |

```jsonc
{
  "id": "…",
  "occurredOn": "2026-11-04",                // sin cambios: día del movimiento, obligatorio
  "occurredAt": "2026-11-05T02:35:00Z",      // NUEVO: instante exacto en UTC, o null
  "occurredTimeZone": "America/Caracas",     // NUEVO: zona IANA del teléfono al fijar la hora, o null
  ...
}
```

En el ejemplo, el movimiento ocurrió el 4 de noviembre a las 10:35 p. m. en Caracas, que en UTC ya es el día 5. Por eso `occurredOn` (el día del usuario) y la fecha de `occurredAt` (UTC) pueden no coincidir. **Eso es correcto**, y es justo lo que valida la regla 3.

Reglas:
1. **Van juntos.** `occurredAt` y `occurredTimeZone` se envían los dos con valor o los dos `null`. Si solo viene uno → `400 INVALID_REQUEST` (REST) o `INVALID_SYNC_PAYLOAD` (sync).
2. **Formatos.**
   - `occurredAt`: ISO-8601 con zona (`Z` u offset como `-04:00`). El servidor lo guarda como `timestamptz` y **siempre lo devuelve en UTC con `Z`**. Precisión de minutos: la app envía segundos en `00`.
   - `occurredTimeZone`: identificador IANA (`America/Caracas`, `Europe/Madrid`…), no un offset fijo como `-04:00`. El servidor rechaza zonas que no existan.
3. **Coherencia con `occurredOn`.** `occurredAt` visto en `occurredTimeZone` debe caer en el día `occurredOn`. Si no → `400` / `INVALID_SYNC_PAYLOAD`. Así la fecha y la hora nunca se contradicen.
4. **`null` = "sin hora".** Es válido y es el valor de todos los movimientos existentes.
5. **Ausente ≠ null** en sync (se aplica al par):
   - Si el payload **no trae** las claves, el servidor **conserva** lo guardado. Esto protege a las versiones viejas de la app, que no conocen los campos y no deben borrarlos.
   - Si las trae con `null`, el servidor las **borra**.
6. **No se valida contra "ahora":** una hora futura se acepta, igual que hoy se aceptan fechas futuras.
7. **El orden de las listas no cambia** en esta fase (`occurredOn desc, createdAt desc, id desc`). La hora es informativa.

Para qué sirve `occurredTimeZone` si ya tenemos UTC:
- Es lo que permite validar la regla 3: sin la zona no se sabe qué día local era.
- Permite que la app, al editar la hora o mover la fecha, conserve la hora local de quien la registró.
- Si alguien que ve el movimiento está en otra zona, la app puede aclararlo (ver 3.2).

### 2.5 Movimiento: tasa USDT congelada (`exchangeSnapshot`) (Fase 2)

`exchangeSnapshot.rates` añade la clave `USDT` en los movimientos de usuarios de Venezuela:

```jsonc
"exchangeSnapshot": {
  "countryCode": "VE",
  "createdWithCurrency": "VES",
  "rates": {
    "BCV":    { ... },
    "EURO":   { ... },
    "CUSTOM": { ... },             // si aplica, sin cambios
    "USDT": {                      // NUEVO, opcional
      "baseCurrency": "USDT",
      "quoteCurrency": "VES",
      "rate": "1008.8891290000",
      "convertedAmountMinor": "9912",
      "convertedCurrency": "USDT",  // "USDT" si el movimiento es en VES; "VES" si es en USD
      "observedAt": "2026-11-04T15:05:02.510Z",
      "precision": "intraday"       // "intraday" (lectura cercana a la hora) | "daily_average"
    }
  }
}
```

Cálculo, mismo criterio que la fila `CUSTOM`:
- Movimiento en **VES** → `convertedAmount = VES / tasaUSDT`, en **USDT**.
- Movimiento en **USD** → `convertedAmount = USD × tasaUSDT`, en **VES** (cuántos Bs cuesta ese monto al precio P2P).

Qué tasa USDT se congela:

| Caso | Tasa usada | `precision` |
|---|---|---|
| Fecha = hoy, sin hora | Último valor observado | `intraday` |
| Con `occurredAt` y hay lecturas guardadas ese día | Última lectura con `observedAt ≤ occurredAt`. Si ninguna es anterior, la primera del día | `intraday` |
| Sin hora, o con hora pero sin lecturas ese día | `p2p_daily_average` de ese día | `daily_average` |
| Fecha anterior a 2026-01-19 o día sin datos | **No hay fila USDT**: la clave `USDT` no viene | — |

**Cambio de comportamiento para BCV y EUR:** hoy el servidor congela la tasa **del momento de guardar**, aunque el movimiento sea de hace meses. Con este cambio congela la tasa **vigente en `occurredOn`**: la tasa BCV publicada para ese día, con historial desde 2023-01-04. Afecta solo a movimientos que se creen o editen después del despliegue. Los existentes no se recalculan.

Cuándo se recalcula el snapshot (re-congelado):
- Hoy: cuando cambian `amountMinor`, `currency`, `occurredOn` o `customRateId`.
- **Nuevo:** también cuando cambia `occurredAt`, porque puede cambiar la lectura USDT. BCV y EUR no cambian con la hora (rigen el día entero), pero se recalculan con el mismo valor.

`accountingAmountMinorUsd` (el libro contable en USD) **sigue calculándose con BCV**. El USDT es solo una referencia de visualización y **no** afecta saldos, presupuestos ni reportes.

**Movimientos existentes:** después del despliegue se ejecuta una sola vez un *backfill* que añade la fila USDT (con `precision: "daily_average"`) a todos los movimientos de usuarios de Venezuela en USD o VES con `occurredOn ≥ 2026-01-19`. Llegan a la app por `/v1/sync/changes` como cualquier otro cambio. Los anteriores a esa fecha quedan sin USDT.

---

## 3. Cambios en la app (checklist completo)

### 3.1 Feature A: USDT en el botón conmutable (solo Venezuela)

**Gate**
- [ ] Leer `features.usdtReferenceRate` de `/v1/me/capabilities` y guardarlo junto a las demás capabilities en el estado o la caché local.
- [ ] Si es `false` o no existe, la app se comporta **exactamente** como hoy.

**Botón conmutable (BCV $ / EUR / USDT)**
- [ ] Añadir la opción **"USDT"** al ciclo o segmento del botón, después de EUR: `BCV $ → EUR → USDT → BCV $`.
- [ ] Revisar **todas** las pantallas donde existe ese botón (inicio, lista de movimientos, detalle, tarjetas de saldo, etc.) y aplicar el mismo cambio en cada una. Si es un componente compartido, cambiarlo en un solo lugar.
- [ ] Si la opción seleccionada se persiste (AsyncStorage o similar), aceptar el nuevo valor `"USDT"`. Si un usuario pierde la capability (cambia de país) con `"USDT"` guardado, volver a `"BCV"`.
- [ ] Icono o etiqueta: texto "USDT". Sugerido: color propio, distinto de BCV y EUR. Kuanto usa naranja para "Promedio USDT".

**Fuente del valor que muestra el botón con USDT seleccionado**
- [ ] **Monto de un movimiento:** usar `exchangeSnapshot.rates.USDT.convertedAmountMinor` y `convertedCurrency`. **No recalcular en el cliente** con la tasa de hoy: el valor congelado es el correcto para ese movimiento.
- [ ] Si el movimiento **no tiene** `rates.USDT` (anterior a 2026-01-19, creado offline y aún no sincronizado, o fuente caída): mostrar "—" o "Sin tasa USDT" en ese movimiento. No inventar un valor.
- [ ] **Totales y agregados con USDT:** sumar los `convertedAmountMinor` de los movimientos que tienen USDT e indicar si alguno quedó fuera, por ejemplo "≈ 1.234 USDT · 3 sin tasa". Esto es decisión de producto: confirmar si el botón afecta totales hoy con BCV y EUR, y replicar el mismo patrón.
- [ ] **Tasa del día** (si el botón muestra la tasa actual en algún lugar): usar `GET /v1/exchange/rates` → `rates.USDT.rate`. Si es `null`, mostrar "No disponible".
- [ ] Mostrar "Actualizado hace X" si `rates.USDT.stale === true`.

**Tipos y parsers**
- [ ] Añadir `"USDT"` a los tipos o enums de `rateSource` y de las claves de `exchangeSnapshot.rates`, y `"USDT"` a `convertedCurrency`.
- [ ] Añadir `usdtReferenceRate` al tipo de capabilities.
- [ ] Añadir `dailyAverage`, `stale` y `precision` como opcionales.
- [ ] **Crítico, revisar antes del despliegue del backend:** comprobar que **la versión actual en producción** de la app **ignora claves desconocidas** en `rates`, `exchangeSnapshot.rates`, `conversions` y `features`. Si algún parser es estricto (por ejemplo zod `.strict()` o un `switch` que lanza error con valores desconocidos), el backend no puede añadir `USDT` hasta que esa versión deje de usarse. Hay que avisar al equipo de backend.

**Base local (SQLite)**
- [ ] Si la app guarda las filas de `exchangeSnapshot` / `transaction_reference_rates` localmente, comprobar que la columna de `rateSource` acepta `"USDT"` y que `displayCurrency`/`convertedCurrency` admite 4 caracteres.

**Modal de crear movimiento**
- [ ] Sin cambios visuales.
- [ ] Si se elige una **fecha pasada**, enviar `occurredOn` al preview (2.3) para que el monto previsto use la tasa de ese día. Esto también corrige el preview de BCV y EUR para fechas pasadas.
- [ ] Si el preview ya muestra BCV y EUR, decidir si se añade USDT en la misma lista. **Por la regla "no modificar otros modales", la propuesta es NO añadirlo.** El USDT solo aparece en el botón conmutable.

### 3.2 Feature B: hora en el tab de detalles (todos los usuarios)

**Base local (SQLite)**
- [ ] Migración local: añadir `occurred_at TEXT NULL` (ISO UTC) y `occurred_time_zone TEXT NULL` a la tabla de movimientos.
- [ ] Los movimientos existentes quedan con `NULL`.

**Al crear un movimiento (lógica, sin UI nueva)**
- [ ] Si la fecha elegida es **hoy** → guardar automáticamente `occurredAt` = instante actual en UTC (segundos en `00`) y `occurredTimeZone` = zona IANA del teléfono (en JS: `Intl.DateTimeFormat().resolvedOptions().timeZone`). El usuario no ve ni toca nada.
- [ ] Si la fecha elegida es **otro día** → guardar los dos en `null`. No adivinar la hora: el usuario puede ponerla después en el detalle.
- [ ] Movimientos generados por recurrencias (en el cliente o por el motor del servidor) → `null`.
- [ ] Movimientos importados → `null`.

**Tab de detalles del movimiento (único lugar con UI nueva)**
- [ ] Nueva fila informativa **"Hora"**, justo debajo de la fila de fecha.
  - Con valor: convertir `occurredAt` (UTC) a la **zona del teléfono** y mostrarlo en el formato del sistema (12 h → "2:35 p. m.", 24 h → "14:35"). Usar el formateador de la plataforma, no un formato fijo ni conversiones manuales de offset.
  - Si al convertir el día cae distinto de `occurredOn` (quien lo ve está en otra zona), mostrar fecha y hora: "5 nov, 3:35 a. m.". Es un caso raro, por ejemplo en espacios compartidos entre países.
  - Sin valor (`null`): mostrar **"Agregar hora"** en estilo secundario o enlace, no "00:00".
- [ ] Al tocar la fila → abrir el **selector de hora nativo** (iOS: `UIDatePicker` mode time / Android: `TimePickerDialog`, o el equivalente del framework), inicializado con la hora guardada convertida a la zona del teléfono o, si es `null`, con la hora actual.
- [ ] Confirmar → la hora elegida se interpreta **en el día `occurredOn` y en la zona del teléfono**. Se convierte a UTC y se guardan `occurredAt` y `occurredTimeZone` (= zona del teléfono). Luego se encola para sync, igual que cualquier otra edición del movimiento.
- [ ] Si tiene valor, ofrecer la opción **"Quitar hora"** (enviar los dos en `null`). Puede ir en el propio selector o como acción secundaria de la fila.
- [ ] La edición se hace **directo desde la fila**, sin abrir el modal de edición general. Ningún otro modal cambia **visualmente**.
- [ ] Permisos: aplicar las mismas reglas que ya existen para editar ese movimiento (por ejemplo, en espacios compartidos). Si el usuario no puede editar el movimiento, la fila es solo lectura.

**Cambio de fecha de un movimiento con hora (lógica, sin UI nueva)**
- [ ] Si el usuario cambia `occurredOn` desde cualquier lugar (por ejemplo el modal de editar) y el movimiento tiene hora: recalcular `occurredAt` con **la misma hora local en el nuevo día**, en `occurredTimeZone`. Si no se hace, el servidor rechaza el cambio por la regla 3 de 2.4.
- [ ] Usar una librería con zonas IANA (`Intl`, `date-fns-tz`, `Luxon` o equivalente) para esa conversión, no sumar o restar horas a mano: hay zonas con horario de verano.

**Sync (subida)**
- [ ] Incluir `occurredAt` y `occurredTimeZone` en el payload de `POST /v1/spaces/:spaceId/sync` → `transactions[]`.
- [ ] Enviarlos **siempre** que la app conozca los campos, ya sea con valor o `null`. La regla "ausente = conservar" es solo para versiones viejas.
- [ ] Actualizar `updatedAt` al editar la hora, como en cualquier edición, para que gane el LWW.

**Sync (bajada)**
- [ ] Leer `occurredAt` y `occurredTimeZone` de `/v1/sync/snapshot` y `/v1/sync/changes` y guardarlos en SQLite.
- [ ] Si un movimiento llega sin la clave (respuesta de un backend viejo), **no** sobrescribir el valor local con `null`.

**Interacción con USDT (solo Venezuela)**
- [ ] Al cambiar la hora de un movimiento VES o USD, el servidor puede volver a congelar la tasa USDT (2.5). La app debe **reemplazar** su `exchangeSnapshot` local con el que llegue por la respuesta o por `/v1/sync/changes`, no conservar el viejo.
- [ ] Mientras el cambio esté offline o pendiente, el USDT mostrado sigue siendo el anterior. No hace falta indicador especial; se actualiza solo al sincronizar.

**Lo que NO se toca en esta fase**
- Modal de crear movimiento (sin selector de hora).
- Modal de editar movimiento general.
- Orden de listas, agrupación por día, filtros, búsqueda, exportaciones, reportes y presupuestos.

### 3.3 QA: casos a probar

| # | Escenario | Resultado esperado |
|---|---|---|
| 1 | Usuario no-VE abre la app | Sin rastro de USDT. Ve la fila "Hora" en el detalle |
| 2 | Usuario VE alterna el botón | BCV $ → EUR → USDT → BCV $ en todas las pantallas que lo tienen |
| 3 | Movimiento VE de hoy en VES, botón en USDT | Monto ≈ VES / tasa USDT actual |
| 4 | Movimiento VE de 2025 | Con USDT seleccionado muestra "—" o "Sin tasa USDT" |
| 5 | Movimiento VE creado con fecha 2026-08-15 | BCV congelado = BCV de ese día (no el de hoy). USDT = promedio de ese día |
| 6 | Mismo movimiento, se le pone hora 14:30 en el detalle | Tras sincronizar, USDT puede cambiar (`precision: intraday` si hay lecturas ese día; si es anterior al despliegue sigue `daily_average`) |
| 7 | Movimiento nuevo con fecha de hoy | Detalle muestra la hora actual, sin que el usuario la haya puesto |
| 8 | Movimiento nuevo con fecha de ayer | Detalle muestra "Agregar hora" |
| 9 | Movimiento viejo (antes del cambio) | Detalle muestra "Agregar hora" |
| 10 | Editar hora offline y luego reconectar | La hora se sube. Otro dispositivo del mismo espacio la recibe |
| 11 | Dispositivo con la versión vieja edita el título de un movimiento con hora | La hora **no** se borra |
| 12 | "Quitar hora" | Vuelve a "Agregar hora" y se sincroniza `null` |
| 13 | Fuente USDT caída | BCV y EUR funcionan. USDT aparece "No disponible". Crear movimientos funciona |
| 14 | Teléfono en formato 12 h vs 24 h | La hora se muestra en el formato del sistema |
| 15 | Usuario cambia de país VE → otro | Desaparece la opción USDT. Si estaba seleccionada, vuelve a BCV |
| 16 | Movimiento a las 10:35 p. m. en Caracas | El servidor guarda `occurredAt` del día siguiente en UTC; el detalle muestra "10:35 p. m." en un teléfono en Caracas |
| 17 | Mismo movimiento visto desde un teléfono en Madrid (espacio compartido) | Muestra "5 nov, 3:35 a. m." (fecha y hora, porque cae en otro día) |
| 18 | Movimiento con hora 14:35 al que se le cambia la fecha en el modal de editar | Conserva 14:35 en el nuevo día; el servidor lo acepta |
| 19 | Usuario viaja y cambia la zona del teléfono | La hora de sus movimientos se muestra convertida a la nueva zona; no cambia nada guardado |

---

## 4. Cambios en el backend (este repo)

Para referencia del equipo de la app; aquí no hay nada que la app deba hacer.

**Base de datos**
1. ✅ Fase 1, `drizzle/0035_venezuela_rate_history.sql`: tabla `venezuela_daily_rates` (espejo de `daily_rates` de Kuanto): `rate_date date PK`, `bcv_usd`, `bcv_eur`, `usdt_last`, `usdt_daily_average`, `usdt_sources jsonb`, `bcv_published_at`, `usdt_observed_at`, `source_updated_at` (cursor de la sincronización) y `synced_at`.
2. ✅ Fase 1, misma migración: tabla **propia** `venezuela_usdt_readings` (`observed_at` único, `rate`, `sources`) para las lecturas intradía. No se reutilizó `exchange_rate_snapshots` porque `loadAllSnapshots` lee las últimas 20 filas de VE: 48 lecturas USDT al día desplazarían las filas BCV/EUR y romperían la tasa vigente.
   - Solo se guarda como lectura intradía un valor observado hace menos de 2 h. La copia inicial del historial (cuyo `p2p_observed_at` es el último del día) no se hace pasar por una lectura con hora.
3. Fase 2: `transactions.occurred_at timestamptz NULL` y `transactions.occurred_time_zone text NULL`, con un `CHECK` que exija que los dos sean nulos o los dos tengan valor.
4. Fase 2: `transaction_reference_rates.display_currency`, ampliar de `varchar(3)` a `varchar(8)` para admitir `"USDT"`.

**Sincronización con Supabase de Kuanto**
- ✅ Variables en `wrangler.jsonc`: `KUANTO_SUPABASE_URL` y `KUANTO_SUPABASE_PUBLISHABLE_KEY`. La clave publicable es pública y solo de lectura; la protege la RLS de Kuanto. Sin ellas el cron no sincroniza (`skipped`).
- ✅ Copia inicial sin script aparte: con la tabla vacía, el primer disparo del cron copia todo `daily_rates` (1022 filas hoy, en 2 páginas). Después solo pide lo modificado desde el último `updated_at` copiado (normalmente 1 fila).
- ✅ Crons en `wrangler.jsonc`: `"0 * * * *"` para recurrencias, invitaciones y BCV del día siguiente; `"10,40 * * * *"` solo para tasas. `scheduled()` distingue por `event.cron` (ver `src/services/venezuela-rate-sync-job.ts`).
- ✅ Idempotente: repetir la copia no duplica nada, y una versión vieja de un día nunca pisa una más nueva.
- ✅ Si Supabase no responde, se sirve lo último guardado con `stale: true`. La caída nunca tumba el resto del cron ni las tasas BCV.
- Fase 2: BCV pasa a salir de `venezuela_daily_rates`. Hasta entonces la tasa BCV **vigente** sigue saliendo del scraper `bcvscrapper.vercel.app/api/bcv` como hoy; el espejo solo se usa para fechas pasadas (`/rates/at`, `/rates/history`).

**Servicios y rutas**
- ✅ `deriveCapabilities`: `usdtReferenceRate`.
- ✅ `getCurrentRates` y `previewConversion`: USDT (nullable, best effort).
- ✅ Rutas `/v1/exchange/rates/at` y `/v1/exchange/rates/history`; `source=USDT` en `/v1/exchange-rates/*`; USDT en `/v1/rates/venezuela`.
- Fase 2: aceptar `occurredOn`/`occurredAt` en el preview.
- `buildMovementSnapshot`: tomar tasas **por fecha y hora del movimiento** en lugar de "ahora", añadir la fila USDT (best effort: si no hay USDT, el movimiento se crea igual) y re-congelar también cuando cambia `occurredAt`.
- `space-sync.ts`:
  - Añadir `occurredAt`/`occurredTimeZone` a `allowedFields` y a la validación (par completo, IANA válida con `Intl.DateTimeFormat`, coherencia con `occurredOn`).
  - Distinguir ausente (conservar) de `null` (borrar).
  - Incluir `occurredAt` en la condición `regenerate`.
- `sync-snapshot.ts`, changes y REST de transacciones: devolver `occurredAt` (UTC con `Z`) y `occurredTimeZone`.
- Backfill único de filas USDT para movimientos VE existentes con `occurredOn ≥ 2026-01-19`.
- Tests: servicio de tasas, snapshot por fecha, sync con y sin `occurredAt` (y versión vieja que no lo envía), validación de zona y de coherencia con `occurredOn`, capabilities, preview con fecha.

---

## 5. Orden de despliegue

1. **Verificar en la app en producción** que los parsers toleran claves nuevas (3.1, "Crítico"). **Esto ya aplica a la Fase 1**: añade `rates.USDT`, `conversions.USDT` y `features.usdtReferenceRate`. Si no las toleran, hay que publicar primero una versión de la app que sí lo haga.
2. **Backend Fase 1:** `npm run db:migrate:production` (migración 0035) y luego deploy. El primer disparo `:10`/`:40` llena el historial; hasta entonces `rates.USDT` es `null`.
3. **Backend Fase 2:** `occurredAt`/`occurredTimeZone`, tasa por fecha/hora del movimiento, fila USDT en el snapshot. Todo compatible con las versiones actuales de la app.
4. **Backfill** de filas USDT en movimientos VE existentes.
5. **Publicar la app** con el botón USDT (VE) y la fila "Hora" en el detalle.
6. Vigilar logs: `cron.venezuela_rate_sync` (fallos de Supabase), `venezuelaRateSync` en el log del cron, `stale` prolongado, `INVALID_SYNC_PAYLOAD` en `occurredAt`/`occurredTimeZone`.

---

## 6. Decisiones abiertas (confirmar antes de implementar)

| # | Pregunta | Propuesta por defecto |
|---|---|---|
| 1 | Movimientos viejos sin hora: ¿mostrar "Agregar hora" o usar la hora de `createdAt` como sugerencia? | **"Agregar hora"**: `createdAt` es cuándo se registró, no cuándo ocurrió, y en movimientos con fecha pasada sería falso |
| 2 | Movimiento en **USD** con el botón en USDT: ¿mostrar Bs al precio P2P (USD × USDT) o los USDT equivalentes vía BCV (USD × BCV / USDT)? | **USD × USDT → Bs**, el mismo criterio que la tasa CUSTOM |
| 3 | ¿El botón en USDT afecta también los totales y saldos de las tarjetas? | Igual que hoy con BCV y EUR, para no crear un caso especial |
| 4 | ¿Añadir USDT a la lista de conversiones del preview en el modal de crear? | **No**, por la regla de no modificar otros modales |
| 5 | ¿Ordenar dentro del mismo día por hora? | **No** en esta fase; se puede hacer después sin cambiar el API |
