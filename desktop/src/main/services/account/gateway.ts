import { create, toBinary } from "@bufbuild/protobuf";
import { Account, AccountChangedSchema, EmptySchema } from "xiaowei-contracts";
import { bindEvent, bindHandlers } from "xiaowei-gateway";
import type { GatewayHost } from "xiaowei-gateway/host";
import type { AccountService } from "./service";

export function registerAccount(host: GatewayHost, service: AccountService) {
  const registration = host.registerOwner(
    "account",
    bindHandlers(Account, {
      get: () => service.snapshot(),
      addServer: (request) => service.addServer(request.serverAddress),
      selectServer: (request) => service.selectServer(request.serverAddress),
      login: (request, client) => service.login(request, client),
      cancelLogin(request) {
        service.cancelLogin(request.attemptId);
        return create(EmptySchema);
      },
      logout: (_request, client) => service.logout(client),
    }),
    [bindEvent(AccountChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const unsubscribe = service.subscribe(() => {
    registration.publish(
      AccountChangedSchema.typeName,
      toBinary(AccountChangedSchema, create(AccountChangedSchema, { snapshot: service.snapshot() })),
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
