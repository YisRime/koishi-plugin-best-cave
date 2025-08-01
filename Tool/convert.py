import json
import datetime
import os

def convert_and_rename_files(
    input_filename='cave.json',
    output_filename='cave_import.json',
    mapping_filename='channel_mapping.json',
    resources_dir='resources'
):
    """
    将旧版 cave.json 转换为新版 cave_import.json 的格式，并根据规则重命名文件。
    请放置在 cave.json 同级目录下，并确保 resources 目录存在。
    转换完成后，生成的文件将保存在同一目录下，但你需要把 resources 目录下的文件移动到同级目录中。
    功能:
    1. 自动加载/保存 userId 到 channelId 的映射 (`channel_mapping.json`)。
    2. 仅在遇到新的 userId 时提示输入。
    3. 在输出的 JSON 文件中，将媒体（图片/视频）文件名更新为新格式:
       ${caveId}_${index}_${channelId}_${userId}${ext}
    4. 在文件系统中，实际重命名 `resources` 目录下的对应媒体文件。
    """
    # 确保 'resources' 目录存在
    if not os.path.exists(resources_dir):
        os.makedirs(resources_dir)
        print(f"已创建 '{resources_dir}' 子目录。请确保所有媒体文件都在此目录中。")

    # 加载已有的 userId -> channelId 映射
    user_channel_map = {}
    try:
        with open(mapping_filename, 'r', encoding='utf-8') as f:
            user_channel_map = json.load(f)
        print(f"成功从 '{mapping_filename}' 加载了 {len(user_channel_map)} 个已有的用户ID映射。")
    except FileNotFoundError:
        print(f"未找到映射文件 '{mapping_filename}'，将在本次运行中创建。")
    except json.JSONDecodeError:
        print(f"警告: '{mapping_filename}' 文件格式错误或为空，将创建一个新的映射。")

    # 读取源数据文件
    try:
        with open(input_filename, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"错误：找不到输入文件 '{input_filename}'。请确保该文件在脚本所在的目录中。")
        return
    except json.JSONDecodeError:
        print(f"错误：'{input_filename}' 文件格式不正确，无法解析。")
        return

    output_data = []
    print("\n开始转换和重命名过程...")

    for item in data:
        cave_id = item.get('cave_id')
        user_id = item.get('contributor_number')
        user_name = item.get('contributor_name', 'Unknown')

        if not all([cave_id, user_id]):
            print(f"警告：跳过一条记录，因为它缺少 'cave_id' 或 'contributor_number'。")
            continue

        # 如果 userId 是新的，则提示用户输入
        if user_id not in user_channel_map:
            print("-" * 20)
            try:
                channel_id = input(f"发现新用户ID，请输入 userId '{user_id}' (用户名: {user_name}) 对应的 channelId: ")
                while not channel_id:
                    print("ChannelId 不能为空，请重新输入。")
                    channel_id = input(f"请输入 userId '{user_id}' (用户名: {user_name}) 对应的 channelId: ")
                user_channel_map[user_id] = channel_id
            except KeyboardInterrupt:
                print("\n操作被用户中断。正在保存已输入的映射...")
                break

        channel_id = user_channel_map[user_id]

        # --- 核心逻辑：处理 elements 并重命名文件 ---
        new_elements = []
        media_index_counter = 1 # 每个 cave_id 的媒体文件索引从1开始
        for element in item.get('elements', []):
            new_element = element.copy()

            # [修改] 同时处理 image 和 video 类型
            if new_element.get('type') in ['image', 'video']:
                original_filename = new_element.get('file')
                if not original_filename:
                    new_elements.append(new_element)
                    continue

                # 1. 构造新文件名
                _, extension = os.path.splitext(original_filename)
                new_filename = f"{cave_id}_{media_index_counter}_{channel_id}_{user_id}{extension}"

                # 2. 定义文件的旧路径和新路径
                old_path = os.path.join(resources_dir, os.path.basename(original_filename))
                new_path = os.path.join(resources_dir, new_filename)

                # 3. 尝试在文件系统中重命名文件
                try:
                    if os.path.exists(old_path):
                        os.rename(old_path, new_path)
                        print(f"  成功重命名: '{os.path.basename(old_path)}' -> '{new_filename}'")
                    else:
                        print(f"  警告: 在 '{resources_dir}' 目录中未找到文件 '{os.path.basename(original_filename)}'。跳过重命名。")

                except Exception as e:
                    print(f"  错误: 重命名 '{os.path.basename(old_path)}' 时发生错误: {e}")

                # 4. 更新 JSON 中的文件名
                new_element['file'] = new_filename
                media_index_counter += 1

            new_elements.append(new_element)

        # 构建输出的 JSON 对象
        new_item = {
            "elements": new_elements,
            "channelId": channel_id,
            "userId": user_id,
            "userName": user_name,
            "status": "active",
            "time": datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
        }
        output_data.append(new_item)

    # 将更新后的映射写回文件
    with open(mapping_filename, 'w', encoding='utf-8') as f:
        json.dump(user_channel_map, f, ensure_ascii=False, indent=2)
    print(f"\n用户ID映射已更新并保存到 '{mapping_filename}'。")

    # 将转换后的数据写入新的 JSON 文件
    with open(output_filename, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)

    print(f"转换完成！数据已保存到 '{output_filename}'。")

# --- 运行脚本 ---
if __name__ == "__main__":
    convert_and_rename_files()
