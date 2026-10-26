import { create, toBinary } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { Account, AccountChangedSchema } from "proto-desktop-ts";
import { bindEvent, bindHandlers } from "xiaowei-gateway";
import type { GatewayHost } from "xiaowei-gateway/host";
import type { AccountService } from "./service";

export function registerAccount(host: GatewayHost, service: AccountService) {
  const registration = host.registerOwner(
    "account",
    bindHandlers(Account, {
      get: () => service.snapshot(),
      addServer: (request, client) => service.addServer(request.serverAddress, client),
      selectServer: (request, client) => service.selectServer(request.serverAddress, client),
      login: (request, client) => service.login(request, client),
      cancelLogin(request) {
        service.cancelLogin(request.attemptId);
        return create(EmptySchema);
      },
      logout: (request, client) => service.logout(request, client),
    }),
    [bindEvent(AccountChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const unsubscribe = service.subscribe(() => {
    registration.publish(
      AccountChangedSchema.typeName,
      toBinary(
        AccountChangedSchema,
        create(AccountChangedSchema, { snapshot: service.snapshot() }),
      ),
    );
  });
  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= (async () => {
        unsubscribe();
        registration.close();
        await service.close();
      })();
      return closing;
    },
  };
}
