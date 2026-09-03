# Plan backend — autenticación obligatoria sin modo invitado

## Objetivo

Una cuenta sin correo verificado no puede leer, crear, modificar ni sincronizar
información. No habrá invitado, acceso anónimo ni migración de invitado.

## Contrato de autorización

Toda ruta privada requiere sesión válida de Better Auth y
`emailVerified === true`.

| Estado | Respuesta |
| --- | --- |
| Sin sesión, inválida o expirada | `401` con código estable. |
| Sesión válida, correo no verificado | `403` con `EMAIL_NOT_VERIFIED`. |
| Sesión válida y correo verificado | Continúa a autorización de recurso/espacio. |

## Checklist de implementación

- [ ] Retirar `guest`, `anonymous`, `guest-migration`, límites y rutas anónimas
  de código, esquema, tipos, pruebas y documentación.
- [ ] Crear usuario con `emailVerified: false` y enviar OTP al registrar.
- [ ] No autorizar la sesión provisional de `sign-up`.
- [ ] Tras OTP válido, establecer `emailVerified: true` y habilitar sesión.
- [ ] Definir expiración, intentos máximos, reenvío y rate limiting del OTP.
- [ ] Aplicar middleware único de sesión + verificación a todo `/v1/*`
  privado: bootstrap, sync, espacios, movimientos, importaciones, avatar,
  exportación y borrado.
- [ ] Mantener checks de pertenencia a espacio y propiedad después del
  middleware.
- [ ] Retirar `POST /v1/sync/guest-migration`, sus tablas, tipos y flags con
  migraciones versionadas.
- [ ] Derivar usuario de bootstrap, snapshot y mutaciones desde la sesión del
  servidor, nunca desde un `userId` del cliente.
- [ ] Estabilizar `EMAIL_NOT_VERIFIED`, `INVALID_OTP`, `OTP_EXPIRED`,
  `TOO_MANY_ATTEMPTS`, `USER_ALREADY_EXISTS`, `FAILED_TO_CREATE_USER` e
  `INTERNAL_SERVER_ERROR`.
- [ ] Devolver `{ error: { code, message } }` sin trazas ni detalles SQL.

## Pruebas obligatorias

- [ ] Registro crea usuario no verificado y no habilita datos.
- [ ] Rutas privadas devuelven `403 EMAIL_NOT_VERIFIED` a sesión sin OTP.
- [ ] OTP válido habilita bootstrap y sync; OTP inválido/vencido no.
- [ ] Sesión expirada devuelve `401` sin filtración de datos.
- [ ] Usuario A no puede leer ni escribir datos o espacios de B.
- [ ] No queda endpoint ni referencia funcional a `guest-migration`.
- [ ] Errores 5xx no filtran infraestructura.

## Criterio de terminado

Una cuenta creada sin OTP no puede obtener, modificar ni sincronizar datos.

## Extensión requerida — eliminar datos y conservar cuenta

Implementar `DELETE /v1/me/data`. Esta ruta no elimina la identidad de Better
Auth ni sus credenciales; borra el contenido de la persona tanto para cumplir
el borrado solicitado como para impedir que una caché de otro dispositivo lo
restaure.

### Contrato

- Requiere sesión válida y correo verificado; aplica el mismo middleware que
  el resto de `/v1/*`.
- No acepta `userId`, espacio ni lista de tablas en el cuerpo: deduce todo de
  la sesión del servidor.
- Devuelve `204` cuando termina. Debe ser idempotente: una segunda llamada
  sobre una cuenta ya vacía también termina correctamente.
- Conserva usuario, correo, contraseña/proveedor, estado de verificación,
  aceptación legal y registros mínimos de seguridad/auditoría.
- Revoca todas las sesiones de la cuenta al finalizar. La aplicación actual
  cerrará su sesión local y eliminará su caché; los demás dispositivos deberán
  iniciar sesión antes de poder sincronizar de nuevo.

### Datos que borra

- Perfil financiero, avatar en R2, espacio personal y todos sus movimientos,
  categorías, cuentas, presupuestos, recurrencias, importaciones, reglas y
  enlaces de sincronización.
- Datos propios asociados a espacios compartidos. Los movimientos o marcas
  que también necesita la otra persona se anonimizan, nunca se eliminan de
  forma que rompa su historial; no se borra ningún dato propiedad de la otra
  persona.
- Cualquier cola, token o estado de sincronización que pudiera volver a subir
  el contenido eliminado.

### Implementación y pruebas

- [ ] Realizar el borrado de PostgreSQL en una transacción y manejar R2 de
  forma idempotente.
- [ ] Revocar todas las sesiones solo después de completar el borrado remoto.
- [ ] Añadir pruebas: cuenta personal queda vacía y puede iniciar sesión de
  nuevo; datos compartidos de la otra persona permanecen; una caché/sesión de
  otro dispositivo no puede reintroducir datos; segunda llamada es `204`.
- [ ] Mantener `DELETE /v1/me` exclusivamente para eliminar cuenta y datos.
