import * as adminCatchAll from "../src/app/api/v1/admin/[...rest]/route";
import * as consent from "../src/app/api/v1/admin/consent/route";
import * as me from "../src/app/api/v1/admin/me/route";
import * as login from "../src/app/api/v1/auth/login/route";
import * as logout from "../src/app/api/v1/auth/logout/route";
import * as revoke from "../src/app/api/v1/devices/[deviceId]/revoke/route";
import * as pair from "../src/app/api/v1/devices/pair/route";
import * as pairingCode from "../src/app/api/v1/devices/pairing-code/route";
import * as devices from "../src/app/api/v1/devices/route";
import * as refresh from "../src/app/api/v1/devices/token/refresh/route";
import * as token from "../src/app/api/v1/devices/token/route";
import * as health from "../src/app/api/v1/health/route";
import * as profiles from "../src/app/api/v1/profiles/route";

export const routes = { adminCatchAll, consent, me, login, logout, revoke, pair, pairingCode, devices, refresh, token, health, profiles };

export const params = <T extends Record<string, string | string[]>>(p: T) => ({ params: Promise.resolve(p) });

export const revokeDevice = (r: Request, deviceId: string) => revoke.POST(r, params({ deviceId }));
