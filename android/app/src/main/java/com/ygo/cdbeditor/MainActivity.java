package com.ygo.cdbeditor;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 本地自定义插件必须在 super.onCreate（Bridge 初始化）之前注册
        registerPlugin(SaveFilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
