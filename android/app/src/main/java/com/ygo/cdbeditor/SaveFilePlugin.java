package com.ygo.cdbeditor;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.InputStream;

/**
 * 自定义 SAF 插件：
 * - saveFile：ACTION_CREATE_DOCUMENT 系统「另存为」，可传 initialUri 让对话框默认落在库文件夹
 * - pickFolder：ACTION_OPEN_DOCUMENT_TREE 选库文件夹，takePersistableUriPermission 持久授权
 * - listCdb：列举库文件夹里的 .cdb 文件
 * - readFile：读任意 SAF 文档内容（base64），供库内 id 查重用
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    @PluginMethod
    public void saveFile(PluginCall call) {
        String filename = call.getString("filename", "download.bin");
        String mime = call.getString("mime", "application/octet-stream");
        String initialUri = call.getString("initialUri", "");

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        // 让「另存为」默认打开用户设置的库文件夹（API 26+）
        if (Build.VERSION.SDK_INT >= 26 && !initialUri.isEmpty()) {
            try {
                intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri.parse(initialUri));
            } catch (Exception ignore) { /* uri 非法就忽略，让系统自己定位 */ }
        }
        startActivityForResult(call, intent, "saveResult");
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result == null || result.getResultCode() != android.app.Activity.RESULT_OK
                || result.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("未获取到保存目标");
            return;
        }
        String data = call.getString("data", "");
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            OutputStream os = getActivity().getContentResolver().openOutputStream(uri);
            if (os == null) {
                call.reject("无法打开输出流");
                return;
            }
            os.write(bytes);
            os.flush();
            os.close();

            // 修复「另存为把 .cdb 改成 .bin」：octet-stream 会被部分选择器按
            // MimeTypeMap 纠正成 .bin，写完检查实际显示名并改回去
            uri = fixExtension(uri, call.getString("filename", ""));

            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("写入失败：" + e.getMessage());
        }
    }

    /** 实际落盘显示名与预期扩展名不符时尝试重命名；失败则返回原 uri（内容不受影响）。 */
    private Uri fixExtension(Uri uri, String intendedName) {
        if (uri == null || intendedName == null || !intendedName.contains(".")) return uri;
        try {
            String display = queryDisplayName(uri);
            if (display == null || display.equals(intendedName)) return uri;
            String intendedExt = intendedName.substring(intendedName.lastIndexOf('.'));
            if (display.toLowerCase().endsWith(intendedExt.toLowerCase())) return uri;
            String base = display.contains(".") ? display.substring(0, display.lastIndexOf('.')) : display;
            Uri renamed = DocumentsContract.renameDocument(
                    getActivity().getContentResolver(), uri, base + intendedExt);
            return renamed != null ? renamed : uri;
        } catch (Exception e) {
            return uri;
        }
    }

    private String queryDisplayName(Uri uri) {
        Cursor c = getActivity().getContentResolver().query(
                uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
        if (c == null) return null;
        try {
            return c.moveToFirst() ? c.getString(0) : null;
        } finally {
            c.close();
        }
    }

    // ---- 库文件夹 ----

    /** 打开文件（ACTION_OPEN_DOCUMENT），可传 initialUri 默认落在库文件夹；返回 {name, data(base64)} */
    @PluginMethod
    public void openFile(PluginCall call) {
        String initialUri = call.getString("initialUri", "");
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*"); // .cdb 无标准 MIME，放开通配让所有文件可见
        if (Build.VERSION.SDK_INT >= 26 && !initialUri.isEmpty()) {
            try {
                intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri.parse(initialUri));
            } catch (Exception ignore) { /* ignore */ }
        }
        startActivityForResult(call, intent, "openResult");
    }

    @ActivityCallback
    private void openResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result == null || result.getResultCode() != android.app.Activity.RESULT_OK
                || result.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("未获取到文件");
            return;
        }
        try {
            JSObject ret = new JSObject();
            ret.put("name", queryDisplayName(uri));
            ret.put("data", readUriBase64(uri));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("读取失败：" + e.getMessage());
        }
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        startActivityForResult(call, intent, "folderResult");
    }

    @ActivityCallback
    private void folderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result == null || result.getResultCode() != android.app.Activity.RESULT_OK
                || result.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("未获取到文件夹");
            return;
        }
        // 持久化读写授权：重启 App 后依然有效
        try {
            final int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
            getActivity().getContentResolver().takePersistableUriPermission(uri, flags);
        } catch (Exception ignore) { /* 部分提供器不支持持久授权，仍返回 uri */ }
        JSObject ret = new JSObject();
        ret.put("uri", uri.toString());
        call.resolve(ret);
    }

    /** 列举树形 uri 下的 .cdb 文件，返回 [{name, uri}] */
    @PluginMethod
    public void listCdb(PluginCall call) {
        String uriStr = call.getString("uri", "");
        if (uriStr.isEmpty()) { call.reject("缺少 uri"); return; }
        try {
            Uri tree = Uri.parse(uriStr);
            // 注意：tree uri 必须用 getTreeDocumentId 取父目录 id。
            // getDocumentId 只认 ".../document/xxx" 形式，传 tree uri 会抛
            // IllegalArgumentException("Invalid URI: ...")，导致列举必然失败。
            String parentId;
            try {
                parentId = DocumentsContract.getTreeDocumentId(tree);
            } catch (IllegalArgumentException e) {
                parentId = DocumentsContract.getDocumentId(tree); // 兼容非标准/旧式 uri
            }
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
            JSArray arr = new JSArray();
            Cursor c = getActivity().getContentResolver().query(children,
                    new String[]{
                            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                            DocumentsContract.Document.COLUMN_DISPLAY_NAME},
                    null, null, null);
            while (c != null && c.moveToNext()) {
                String name = c.getString(1);
                if (name == null || !name.toLowerCase().endsWith(".cdb")) continue;
                JSObject o = new JSObject();
                o.put("name", name);
                o.put("uri", DocumentsContract.buildDocumentUriUsingTree(
                        tree, c.getString(0)).toString());
                arr.put(o);
            }
            if (c != null) c.close();
            JSObject ret = new JSObject();
            ret.put("files", arr);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("列举失败：" + e.getMessage());
        }
    }

    /** 读取 SAF 文档内容，返回 base64 */
    @PluginMethod
    public void readFile(PluginCall call) {
        String uriStr = call.getString("uri", "");
        if (uriStr.isEmpty()) { call.reject("缺少 uri"); return; }
        try {
            JSObject ret = new JSObject();
            ret.put("data", readUriBase64(Uri.parse(uriStr)));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("读取失败：" + e.getMessage());
        }
    }

    /** 公共：经 ContentResolver 读整个文档为 base64 字符串 */
    private String readUriBase64(Uri uri) throws Exception {
        InputStream is = getActivity().getContentResolver().openInputStream(uri);
        if (is == null) throw new Exception("无法打开输入流");
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
    }

    // ---- 内部存储（导入的官方卡库存这里，App 私有目录，无需权限，重启仍在） ----

    /** 写内部存储：{name, data(base64)}；先写 .tmp 再改名，避免写一半崩溃留下坏库 */
    @PluginMethod
    public void saveInternal(PluginCall call) {
        String name = call.getString("name", "file.bin");
        String data = call.getString("data", "");
        try {
            File dir = getActivity().getFilesDir();
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            File tmp = new File(dir, name + ".tmp");
            FileOutputStream fos = new FileOutputStream(tmp);
            fos.write(bytes);
            fos.flush();
            fos.close();
            File dst = new File(dir, name);
            if (dst.exists()) dst.delete();
            if (!tmp.renameTo(dst)) {
                tmp.delete();
                call.reject("写入失败：无法落盘");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("path", dst.getAbsolutePath());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("写入失败：" + e.getMessage());
        }
    }

    /** 读内部存储：{name} → {data(base64)}；不存在时 data 为 null */
    @PluginMethod
    public void readInternal(PluginCall call) {
        String name = call.getString("name", "");
        try {
            File f = new File(getActivity().getFilesDir(), name);
            JSObject ret = new JSObject();
            if (!f.exists() || !f.isFile()) {
                ret.put("data", null);
                call.resolve(ret);
                return;
            }
            FileInputStream fis = new FileInputStream(f);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = fis.read(buf)) > 0) bos.write(buf, 0, n);
            fis.close();
            ret.put("data", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("读取失败：" + e.getMessage());
        }
    }
}
