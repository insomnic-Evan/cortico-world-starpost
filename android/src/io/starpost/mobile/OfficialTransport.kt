package io.starpost.mobile

// Translate only the two official origins; saved sessions/content scopes keep their original key.
internal fun starpostTransport(value: String): String = when(value.trimEnd('/')) {
    "https://starpost.com.cn", "https://starpost.com.cn:443" -> "https://8.148.13.225"
    else -> value.trimEnd('/')
}
internal fun hubTransport(value: String): String = when(value.trimEnd('/')) {
    "https://ffahub.net", "https://ffahub.net:443" -> "https://8.148.13.225:8443"
    else -> value
}
