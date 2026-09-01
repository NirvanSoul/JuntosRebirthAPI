# Plan backend — autenticación obligatoria sin modo invitado

## Objetivo

El backend es la autoridad final: una cuenta sin correo verificado no puede
leer, crear, modificar ni sincronizar información. No habrá invitado, acceso
anónimo ni migración de invitado.

## Contrato de autorización

Una solicitud privada requiere sesión válida de Better Auth y
`emailVerified === true`.

| Estado | Respuesta |
| --- | --- |
| Sin sesión, inválida o expirada | `401` con código de autenticación estable. |
| Sesión válida, correo no verificado | `403` con `{ error: { code: "EMAIL_NOT_VERIFIED", message } }`. |
| Sesión válida y correo verificado | Continúa a autorización de recurso/espacio. |

## Secuencia de implementación

### 1. Auditar invitado

- [ ] Buscar `guest`, `anonymous`, `guest-migration`, límites y rutas anónimas
  en código, esquema, tipos, pruebas y documentación.
- [ ] Inventariar endpoints, tablas, flags y jobs relacionados.

### 2. Registro y OTP

- [ ] Crear usuario con `emailVerified: false` y enviar OTP.
- [ ] La sesión provisional de `sign-up` no autoriza la aplicación.
- [ ] OTP válido establece `emailVerified: true` y crea/habilita sesión usable.
- [ ] Definir expiración, máximo de intentos, reenvío y rate limiting.
- [ ] No devolver trazas, SQL ni texto interno del proveedor.

### 3. Middleware único

- [ ] Crear/revisar middleware reutilizable de sesión + verificación.
- [ ] Aplicarlo a todo `/v1/*` privado: bootstrap, perfil, sync, espacios,
  categorías, cuentas, movimientos, recurrencias, invitaciones, importaciones,
  avatar, exportación y borrado.
- [ ] Evitar checks dispersos en handlers.
- [ ] Mantener después validación de pertenencia a espacio y propiedad.

### 4. Eliminar invitado

- [ ] Retirar `POST /v1/sync/guest-migration` y equivalentes.
- [ ] Retirar tablas, columnas, índices, tipos, flags y límites exclusivos de
  invitados mediante migraciones versionadas.
- [ ] Confirmar que no queda una mutación financiera sin `userId`, autor y
  espacio válidos derivados del servidor.

### 5. Datos de usuario autenticado

- [ ] Bootstrap y snapshot derivan el usuario de la sesión, nunca de un ID
  recibido del cliente.
- [ ] Lecturas filtran por pertenencia; un `spaceId` del cliente no concede
  acceso.
- [ ] Rechazar lotes de sincronización sin sesión verificada antes de procesar
  filas.

### 6. Contrato de errores

- [ ] Usar `{ error: { code, message } }`.
- [ ] Estabilizar: `EMAIL_NOT_VERIFIED`, `INVALID_OTP`, `OTP_EXPIRED`,
  `TOO_MANY_ATTEMPTS`, `USER_ALREADY_EXISTS`, `FAILED_TO_CREATE_USER` e
  `INTERNAL_SERVER_ERROR`.
- [ ] Registrar internamente causa y request ID; enviar al cliente solo un
  mensaje seguro.

### 7. Pruebas obligatorias

- [ ] Registro crea usuario no verificado y no habilita datos.
- [ ] Usuario no verificado recibe `403 EMAIL_NOT_VERIFIED` en cada familia de
  rutas privadas.
- [ ] OTP válido habilita bootstrap y sync; inválido/vencido/exceso no.
- [ ] Sesión expirada recibe `401` sin filtración.
- [ ] Usuario A no lee ni escribe datos/espacios de B.
- [ ] No queda endpoint ni referencia funcional a `guest-migration`.
- [ ] Errores 5xx no filtran infraestructura.

### 8. Despliegue

- [ ] Publicar primero middleware y pruebas.
- [ ] Verificar en staging que toda sesión no verificada recibe 403 en rutas
  privadas.
- [ ] Coordinar contrato de errores y versión cliente.
- [ ] Monitorizar `EMAIL_NOT_VERIFIED`, fallos de envío OTP y errores de alta.

## Criterio de terminado

Una cuenta creada sin OTP no puede obtener, modificar ni sincronizar datos,
incluso si llama directamente a la API con una sesión provisional.
