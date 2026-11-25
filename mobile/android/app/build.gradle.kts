plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android Gradle plugin.
    id("dev.flutter.flutter-gradle-plugin")
}

val rustLibraries = layout.buildDirectory.dir("generated/rustJniLibs")

android {
    namespace = "com.tctony.xiaowei.mobile"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.tctony.xiaowei"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    sourceSets.getByName("main").jniLibs.srcDir(rustLibraries.get().asFile)
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

val buildRust = tasks.register<Exec>("buildMobileRust") {
    doFirst {
        commandLine(
            "sh",
            file("../../tool/build-rust.sh").absolutePath,
            "android",
            android.ndkDirectory.absolutePath,
            rustLibraries.get().asFile.absolutePath,
        )
    }
}

tasks.named("preBuild") {
    dependsOn(buildRust)
}
