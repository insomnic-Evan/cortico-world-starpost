package io.starpost.mobile

import android.app.Application
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.core.app.ApplicationProvider
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk=[35])
class OwnerAddressPromptTest {
    @get:Rule val compose=createComposeRule()
    private fun ui()=UiActions(StarpostClient(ApplicationProvider.getApplicationContext<Application>()))
    private fun state(address:String="",prompted:Boolean=false)=ClientState(starting=false,signedIn=true,
        account=obj("humanId" to "10003H","botId" to "10001","address" to address,"addressPrompted" to prompted),route=Route("owner"))

    @Test fun firstPromptWaitsForLoadingAndAllowsEmptyAddress(){
        val ui=ui();val state=mutableStateOf(state().copy(loading=true))
        compose.setContent{StarpostTheme("light",false){Text("专属频道");OwnerAddressPrompt(ui,state.value)}}
        compose.onNodeWithText("希望 bot 怎样称呼你？").assertDoesNotExist()
        compose.runOnIdle{state.value=state.value.copy(loading=false)}
        compose.onNodeWithText("希望 bot 怎样称呼你？").assertExists()
        compose.onNodeWithText("不填写").assertIsEnabled()
        compose.onNodeWithText("保存").assertIsEnabled()
        compose.onNodeWithText("称呼（可留空）").performTextInput("旅人")
        compose.onNodeWithText("旅人").performTextClearance()
        compose.onNodeWithText("保存").assertIsEnabled()
    }

    @Test fun existingLegacyAddressDoesNotPromptAgain(){
        val ui=ui()
        compose.setContent{StarpostTheme("light",false){Text("专属频道");OwnerAddressPrompt(ui,state("旅人"))}}
        compose.onNodeWithText("希望 bot 怎样称呼你？").assertDoesNotExist()
    }

    @Test fun previouslySkippedAddressDoesNotPromptAgain(){
        val ui=ui()
        compose.setContent{StarpostTheme("light",false){Text("专属频道");OwnerAddressPrompt(ui,state(prompted=true))}}
        compose.onNodeWithText("希望 bot 怎样称呼你？").assertDoesNotExist()
    }
}
