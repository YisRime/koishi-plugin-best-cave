import os
import json
import filetype

# --- 配置区 ---
# 请根据你的实际情况修改这些路径
# JSON 文件的路径
json_path = 'cave_export.json'
# 包含图片文件的目录路径
image_dir = 'cave'
# --- 配置结束 ---


def correct_files_and_update_json(json_file_path: str, files_base_dir: str):
    """
    读取文件内容以纠正其拓展名，并同步更新 JSON 文件中的记录。
    """
    # 步骤 1: 检查路径是否存在
    if not os.path.exists(json_file_path):
        print(f"错误: JSON 文件未找到，路径: '{json_file_path}'")
        return

    if not os.path.isdir(files_base_dir):
        print(f"错误: 图片目录未找到，路径: '{files_base_dir}'")
        return

    # 步骤 2: 加载 JSON 数据到内存
    print("正在加载 JSON 数据...")
    with open(json_file_path, 'r', encoding='utf-8') as f:
        try:
            cave_data = json.load(f)
        except json.JSONDecodeError as e:
            print(f"错误: JSON 文件格式无效，无法解析。 {e}")
            return

    total_corrected = 0
    total_skipped = 0
    
    print("\n开始检查并修正文件拓展名...")

    # 步骤 3: 遍历 JSON 中的每一个条目
    for cave in cave_data:
        elements = cave.get('elements', [])
        if not elements:
            continue

        for element in elements:
            # 只处理包含 'file' 键的元素
            if 'file' in element:
                original_filename = element['file']
                current_path = os.path.join(files_base_dir, original_filename)

                # 检查文件是否存在
                if not os.path.exists(current_path):
                    print(f"  - [跳过] 文件不存在: {original_filename}")
                    total_skipped += 1
                    continue

                try:
                    # 步骤 4: 识别文件的真实类型
                    kind = filetype.guess(current_path)

                    # 如果无法识别，则跳过
                    if kind is None:
                        print(f"  - [跳过] 无法识别文件类型: {original_filename}")
                        total_skipped += 1
                        continue
                    
                    # 获取正确的文件拓展名 (例如: 'jpg', 'png')
                    correct_extension = f".{kind.extension}"
                    
                    # 获取当前文件名和拓展名
                    filename_root, current_extension = os.path.splitext(original_filename)

                    # 步骤 5: 如果当前拓展名不正确，则进行重命名和更新
                    if current_extension.lower() != correct_extension.lower():
                        new_filename = f"{filename_root}{correct_extension}"
                        new_path = os.path.join(files_base_dir, new_filename)

                        # 重命名物理文件
                        os.rename(current_path, new_path)

                        # 在内存中更新 JSON 数据
                        element['file'] = new_filename
                        
                        print(f"  - [成功] '{original_filename}' -> '{new_filename}'")
                        total_corrected += 1
                    else:
                        # 如果拓展名已经是正确的，则无需操作
                        print(f"  - [正确] 文件拓展名已是正确的: {original_filename}")

                except Exception as e:
                    print(f"  - [错误] 处理文件 {original_filename} 时发生意外错误: {e}")
                    total_skipped += 1

    # 步骤 6: 将修改后的数据写回 JSON 文件
    if total_corrected > 0:
        print("\n正在将更新后的数据写回 JSON 文件...")
        try:
            with open(json_file_path, 'w', encoding='utf-8') as f:
                # 使用 indent=2 格式化 JSON，使其更易读
                json.dump(cave_data, f, ensure_ascii=False, indent=2)
            print("JSON 文件更新成功！")
        except Exception as e:
            print(f"错误: 写入 JSON 文件失败: {e}")
    else:
        print("\n所有文件拓展名均正确，无需更新 JSON 文件。")


    print("\n--- 操作完成 ---")
    print(f"已修正的文件数: {total_corrected}")
    print(f"已跳过的文件数: {total_skipped}")


if __name__ == "__main__":
    correct_files_and_update_json(json_path, image_dir)