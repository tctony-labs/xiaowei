import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import xiaowei.mobile.*

fun main(arguments: Array<String>) = runBlocking {
    check(arguments.size == 9)
    val server = arguments[0]
    val valid = Base64.getDecoder().decode(arguments[1])
    val expired = Base64.getDecoder().decode(arguments[2])
    val rotated = Base64.getDecoder().decode(arguments[3])
    val updated = Base64.getDecoder().decode(arguments[4])
    val loginRequest = Base64.getDecoder().decode(arguments[5])
    val healthResponse = Base64.getDecoder().decode(arguments[6])
    val businessResponse = Base64.getDecoder().decode(arguments[7])
    val updated2 = Base64.getDecoder().decode(arguments[8])

    fun context(suffix: String = "", auth: ByteArray? = null, connect: Boolean = false) =
        SessionContext(server + suffix, auth, connect)

    val options = RequestOptions(null, Transport.AUTO)
    val client = MobileClient()
    val subscription = client.subscribeConnection()
    check(subscription.next()?.status == ConnectionStatus.DISCONNECTED)
    client.setSession(context(auth = valid, connect = true))
    while (true) {
        val snapshot = checkNotNull(subscription.next())
        if (snapshot.status == ConnectionStatus.CONNECTED) {
            check(snapshot.generation > 0uL)
            check(snapshot.authentication == Authentication.AUTHENTICATED)
            break
        }
    }
    val websocket = client.invoke(
        context(auth = valid), "xiaowei.server.auth.Auth.GetCurrentUser", byteArrayOf(),
        RequestOptions(null, Transport.WEBSOCKET)
    )
    check(websocket.run().isNotEmpty())
    websocket.shutdown()
    websocket.close()

    val health = client.invoke(
        context(auth = valid), "xiaowei.server.common.Health.Check", byteArrayOf(), options
    )
    check(health.run().contentEquals(healthResponse))
    check(health.run().contentEquals(healthResponse))
    health.shutdown()
    health.close()
    val business = client.invoke(
        context("/business"), "xiaowei.server.common.Health.Check", byteArrayOf(), options
    )
    check(business.run().contentEquals(businessResponse))
    business.shutdown()
    business.close()

    val never = client.invoke(
        context("/never"), "xiaowei.server.common.Health.Check", byteArrayOf(), options
    )
    never.cancel()
    try {
        never.run()
        error("cancelled request ran")
    } catch (exception: MobileException.Core) {
        check(exception.category == "cancelled")
    }
    never.shutdown()
    never.close()

    val timeout = client.invoke(
        context("/timeout"), "xiaowei.server.common.Health.Check", byteArrayOf(),
        RequestOptions(30u, Transport.HTTP)
    )
    try {
        timeout.run()
        error("request did not time out")
    } catch (exception: MobileException.Core) {
        check(exception.category == "timeout")
    }
    timeout.shutdown()
    timeout.close()

    val slow = client.invoke(
        context("/cancel"), "xiaowei.server.common.Health.Check", byteArrayOf(), options
    )
    val task = async(Dispatchers.Default) {
        try {
            slow.run()
        } finally {
            slow.cancel()
            withContext(NonCancellable) { slow.shutdown() }
        }
    }
    check(readln() == "cancel")
    task.cancelAndJoin()
    slow.close()

    val restore = client.restore(context(auth = expired), false)
    val checkpoint = restore.run()
    check(checkpoint.code == 0 && checkpoint.checkpoint)
    check(checkpoint.authenticated.contentEquals(rotated))
    restore.cancel()
    val retained = withContext(NonCancellable) { restore.settledResult() }
    check(retained.code != 0 && !retained.checkpoint)
    check(retained.authenticated.contentEquals(rotated))
    check(retained.credentialVersion == checkpoint.credentialVersion)
    restore.shutdown()
    restore.close()

    val resumed = client.restore(context(auth = rotated), false)
    val result = resumed.run()
    check(result.code == 0 && !result.checkpoint)
    check(result.authenticated.contentEquals(updated))
    resumed.shutdown()
    resumed.close()
    val continued = client.restore(context(auth = updated), true)
    val nextCheckpoint = continued.run()
    check(nextCheckpoint.code == 0 && nextCheckpoint.checkpoint)
    check(nextCheckpoint.authenticated.contentEquals(updated2))
    client.setSession(context(auth = updated2))
    val continuedResult = continued.resume(nextCheckpoint.credentialVersion)
    check(continuedResult.code == 0 && !continuedResult.checkpoint)
    check(continuedResult.credentialVersion == nextCheckpoint.credentialVersion)
    check(continuedResult.authenticated.contentEquals(updated2))
    continued.shutdown()
    continued.close()
    val logout = client.logout(context(auth = updated2))
    check(logout.run().code == 0)
    logout.shutdown()
    logout.close()
    val login = client.login(context(), loginRequest)
    val loggedIn = login.run()
    check(loggedIn.code == 0 && loggedIn.authenticated.contentEquals(valid))
    login.shutdown()
    login.close()

    subscription.stop()
    check(subscription.next() == null)
    subscription.close()
    client.pause()
    client.setSession(context())
    val finalCall = client.invoke(
        context("/close"), "xiaowei.server.common.Health.Check", byteArrayOf(), options
    )
    val finalTask = async(Dispatchers.Default) {
        try {
            finalCall.run()
            false
        } catch (_: MobileException.Core) {
            true
        }
    }
    check(readln() == "close")
    client.shutdown()
    client.shutdown()
    check(finalTask.await())
    finalCall.close()
    client.close()
    println("Kotlin bindings passed")
}
